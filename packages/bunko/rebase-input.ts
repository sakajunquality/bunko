import { BlobStore } from "../oci/blob-store.ts";
import { descriptor, object } from "../oci/digest.ts";
import { canonicalOutput } from "../oci/layout.ts";
import { LayoutSource, RegistrySource, resolveBase, type ImageSource } from "../oci/source.ts";
import type { RegistryOptions } from "../oci/registry.ts";
import { media, type BaseImage, type Descriptor, type Platform } from "../oci/types.ts";

const indexes: string[] = [media.index, media.dockerIndex];
const manifests: string[] = [media.manifest, media.dockerManifest];

/** Snapshot input metadata by digest; layer readers still verify each blob when consumed. */
export async function rebaseInput(reference: string, registry: RegistryOptions, store: BlobStore) {
  if (!reference || reference.startsWith("layout:") && !reference.slice(7)) throw new Error("Rebase input requires a nonempty reference");
  const local = reference.startsWith("layout:") ? await canonicalOutput(reference.slice(7)) : undefined;
  const origin = local ? new LayoutSource(local) : new RegistrySource(reference, registry);
  if (origin instanceof RegistrySource && !origin.ref.reference.startsWith("sha256:")) throw new Error("Rebase registry inputs must be digest-pinned");
  const root = await origin.root();
  await store.putStream((async function* () { yield root.bytes; })(), root.descriptor.mediaType, root.descriptor);
  const seen = new Map<string, Descriptor>(); let bytes = 0;
  async function json(d: Descriptor): Promise<Record<string, unknown>> {
    const prior = seen.get(d.digest);
    if (prior && (prior.size !== d.size || prior.mediaType !== d.mediaType)) throw new Error("Conflicting rebase input descriptors");
    if (!prior) {
      if (d.size > 8 * 1024 ** 2 || seen.size >= 1000 || bytes + d.size > 64 * 1024 ** 2) throw new Error("Rebase input metadata exceeds limits");
      bytes += d.size; seen.set(d.digest, d);
      if (d.digest !== root.descriptor.digest) await store.putStream(await origin.blob(d), d.mediaType, d);
    }
    return object(JSON.parse(Buffer.from(await store.read(d)).toString()), "Rebase image metadata");
  }
  const imageRoot = origin instanceof LayoutSource ? await origin.baseRoot() : root;
  const source: ImageSource = { root: async () => imageRoot, blob: origin.blob.bind(origin) };
  async function resolveImage(platform: Platform): Promise<BaseImage> {
    const result = await resolveBase(source, platform, store, true);
    const raw = await json(result.descriptor);
    if (raw.annotations !== undefined) {
      const annotations = object(raw.annotations, "Image annotations");
      if (Object.values(annotations).some((value) => typeof value !== "string")) throw new Error("Invalid image annotations");
      Object.assign(result.manifest, { annotations });
    }
    if (origin instanceof RegistrySource) for (const layer of result.manifest.layers) store.origins.set(layer.digest, origin.ref);
    return result;
  }
  const images = new Map<string, Promise<BaseImage>>();
  function image(platform: Platform): Promise<BaseImage> {
    const key = `${platform.os}/${platform.architecture}/${platform.variant ?? ""}`;
    let pending = images.get(key);
    if (!pending) { pending = resolveImage(platform); images.set(key, pending); }
    return pending;
  }
  async function platforms(): Promise<Platform[]> {
    const found = new Map<string, Platform>();
    let visits = 0;
    async function walk(d: Descriptor, depth = 0): Promise<void> {
      if (depth > 8 || ++visits > 1000) throw new Error("Rebase image index traversal exceeds limits");
      const value = await json(d);
      if (value.schemaVersion !== 2 || value.mediaType !== undefined && value.mediaType !== d.mediaType) throw new Error("Invalid rebase image schema");
      if (value.subject || value.artifactType && ![media.config, media.dockerConfig].includes(value.artifactType as typeof media.config)) return;
      if (indexes.includes(d.mediaType)) {
        if (!Array.isArray(value.manifests) || value.manifests.length > 1000) throw new Error("Invalid rebase image index");
        for (const child of value.manifests) await walk(descriptor(child), depth + 1);
      } else if (manifests.includes(d.mediaType)) {
        const configDescriptor = descriptor(value.config);
        if (![media.config, media.dockerConfig].includes(configDescriptor.mediaType as typeof media.config)) throw new Error("Rebase input contains an unsupported image");
        const config = await json(configDescriptor);
        if (config.os !== "linux" || !["amd64", "arm64"].includes(String(config.architecture)) || config.variant !== undefined && !(config.architecture === "arm64" && config.variant === "v8")) throw new Error("Rebase supports only Linux amd64 and arm64/v8 images");
        const platform: Platform = { os: "linux", architecture: config.architecture as Platform["architecture"], ...(config.variant ? { variant: String(config.variant) } : {}) };
        const key = `${platform.os}/${platform.architecture}`;
        if (found.has(key)) throw new Error(`Ambiguous rebase image platform: ${key}`);
        found.set(key, platform);
      } else throw new Error("Unsupported rebase image media type");
    }
    await walk(root.descriptor);
    if (!found.size) throw new Error("Rebase input has no runnable images");
    return [...found.values()];
  }
  // Exported layouts add one wrapper index around the published image root.
  let subject = root.descriptor;
  if (local) {
    const value = await json(root.descriptor);
    if (!Array.isArray(value.manifests)) throw new Error("Invalid rebase layout index");
    const runnable = value.manifests.map(descriptor).filter((d) => !d.artifactType || [media.config, media.dockerConfig].includes(d.artifactType as typeof media.config));
    if (runnable.length === 1) subject = runnable[0]!;
  }
  return { root: root.descriptor, subject, local, origin, image, platforms, json };
}
