import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RegistryClient, responseBytes, webStream, type Fetcher, type RegistryOptions } from "./registry.ts";
import { BlobStore } from "./blob-store.ts";
import { descriptor, object, sha256 } from "./digest.ts";
import { media, type BaseImage, type Descriptor, type ImageConfig, type ImageManifest, type Platform } from "./types.ts";

export interface ImageSource {
  root(): Promise<{ descriptor: Descriptor; bytes: Uint8Array }>;
  blob(d: Descriptor): Promise<AsyncIterable<Uint8Array>>;
}

export class LayoutSource implements ImageSource {
  constructor(readonly directory: string) { }
  async root() {
    const marker = object(JSON.parse(await readFile(join(this.directory, "oci-layout"), "utf8")), "OCI layout");
    if (marker.imageLayoutVersion !== "1.0.0") throw new Error("Unsupported OCI layout version");
    const bytes = await readFile(join(this.directory, "index.json"));
    if (bytes.length > 8 * 1024 * 1024) throw new Error("Base index exceeds metadata size limit");
    return { bytes, descriptor: { mediaType: media.index, digest: sha256(bytes), size: bytes.length } };
  }
  async blob(d: Descriptor) {
    return createReadStream(new BlobStore(this.directory).path(d.digest));
  }
}

export interface RegistryReference {
  registry: string;
  repository: string;
  reference: string;
}

export function parseReference(value: string): RegistryReference {
  if (value.includes("://") || /[\s?#]/.test(value)) throw new Error(`Invalid image reference: ${value}`);
  const parts = value.split("@");
  if (parts.length > 2 || (parts.length === 2 && !parts[1])) throw new Error(`Invalid image reference: ${value}`);
  let path = parts[0]!;
  let reference = parts[1];
  if (reference) descriptor({ digest: reference, size: 0, mediaType: media.manifest });
  const lastColon = path.lastIndexOf(":"), lastSlash = path.lastIndexOf("/");
  if (lastColon > lastSlash) {
    if (reference) throw new Error("An image reference must use a tag or a digest, not both");
    reference = path.slice(lastColon + 1);
    path = path.slice(0, lastColon);
  }
  reference ??= "latest";
  if (!reference.startsWith("sha256:") && !/^[\w][\w.-]{0,127}$/.test(reference)) throw new Error("Invalid image tag");
  const components = path.split("/");
  let registry = "registry-1.docker.io";
  if (components.length > 1 && (/[.:]/.test(components[0]!) || components[0] === "localhost")) {
    registry = components.shift()!.toLowerCase();
  }
  if (["docker.io", "index.docker.io"].includes(registry)) registry = "registry-1.docker.io";
  if (!/^[a-z0-9.-]+(?::[0-9]+)?$/.test(registry)) throw new Error("Invalid registry host");
  if (registry === "registry-1.docker.io" && components.length === 1) components.unshift("library");
  if (components.some((p) => !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(p))) {
    throw new Error("Invalid registry repository");
  }
  return { registry, repository: components.join("/"), reference };
}

export { type Fetcher } from "./registry.ts";

export class RegistrySource implements ImageSource {
  readonly ref: RegistryReference;
  readonly client: RegistryClient;
  constructor(value: string, options: RegistryOptions | Fetcher = {}) {
    this.ref = parseReference(value);
    this.client = new RegistryClient(this.ref.registry, typeof options === "function" ? { fetcher: options, credentials: async () => undefined } : options);
  }
  async root() {
    const response = await this.client.request(`/v2/${this.ref.repository}/manifests/${this.ref.reference}`, {}, [`repository:${this.ref.repository}:pull`]);
    const bytes = await responseBytes(response);
    const digest = sha256(bytes);
    if (this.ref.reference.startsWith("sha256:") && digest !== this.ref.reference) throw new Error("Base manifest digest mismatch");
    const declared = response.headers.get("docker-content-digest");
    if (declared && declared !== digest) throw new Error("Registry manifest digest header mismatch");
    const parsed = object(JSON.parse(Buffer.from(bytes).toString()), "Base manifest");
    const contentType = response.headers.get("content-type")?.split(";")[0];
    return { bytes, descriptor: descriptor({ mediaType: parsed.mediaType ?? contentType, digest, size: bytes.length }) };
  }
  async blob(d: Descriptor) {
    const manifest = [media.index, media.manifest, media.dockerIndex, media.dockerManifest].includes(d.mediaType as typeof media.index);
    const response = await this.client.request(`/v2/${this.ref.repository}/${manifest ? "manifests" : "blobs"}/${d.digest}`, {}, [`repository:${this.ref.repository}:pull`]);
    if (!response.body) throw new Error(`Missing blob body: ${d.digest}`);
    return webStream(response.body);
  }
}

export function validateImageConfig(value: unknown, platform: Platform, layerCount: number): ImageConfig {
  const config = object(value, "Image config");
  if (config.os !== platform.os || config.architecture !== platform.architecture) throw new Error("Base image platform does not match the requested platform");
  if (config.variant !== undefined && config.variant !== (platform.variant ?? (platform.architecture === "arm64" ? "v8" : undefined))) throw new Error("Base image variant does not match the requested platform");
  const rootfs = object(config.rootfs, "Image rootfs");
  if (rootfs.type !== "layers" || !Array.isArray(rootfs.diff_ids) || rootfs.diff_ids.length !== layerCount) {
    throw new Error("Base rootfs DiffIDs do not match its layers");
  }
  for (const digest of rootfs.diff_ids) descriptor({ digest, size: 0, mediaType: media.tar });
  if (config.history != null) {
    if (!Array.isArray(config.history)) throw new Error("Invalid base history");
    for (const row of config.history) {
      const item = object(row, "History entry");
      for (const key of ["created", "created_by", "comment"]) {
        if (item[key] != null && typeof item[key] !== "string") throw new Error(`Invalid history ${key}`);
      }
      if (item.empty_layer != null && typeof item.empty_layer !== "boolean") throw new Error("Invalid history empty_layer");
    }
    if (config.history.filter((row) => !row.empty_layer).length !== layerCount) throw new Error("Base history does not match its layers");
  }
  if (config.author != null && typeof config.author !== "string") throw new Error("Invalid base author");
  if (config.config != null) {
    const runtime = object(config.config, "Runtime config");
    for (const key of ["Env", "Entrypoint", "Cmd"]) {
      if (runtime[key] != null && (!Array.isArray(runtime[key]) || !(runtime[key] as unknown[]).every((s) => typeof s === "string"))) throw new Error(`Invalid base ${key}`);
    }
    for (const key of ["User", "WorkingDir", "StopSignal"]) {
      if (runtime[key] != null && typeof runtime[key] !== "string") throw new Error(`Invalid base ${key}`);
    }
    if (runtime.Labels != null && !Object.values(object(runtime.Labels, "Base labels")).every((s) => typeof s === "string")) throw new Error("Invalid base labels");
    for (const key of ["ExposedPorts", "Volumes"]) {
      if (runtime[key] != null) {
        for (const item of Object.values(object(runtime[key], `Base ${key}`))) object(item, `Base ${key} entry`);
      }
    }
  }
  return config as unknown as ImageConfig;
}

export async function resolveBase(source: ImageSource, platform: Platform, store: BlobStore, lazy = false): Promise<BaseImage> {
  const root = await source.root();
  await store.putStream(ReadableBytes(root.bytes), root.descriptor.mediaType, root.descriptor);
  async function metadata(d: Descriptor): Promise<Record<string, unknown>> {
    if (d.size > 8 * 1024 * 1024) throw new Error("Base metadata exceeds size limit");
    if (d.digest !== root.descriptor.digest) await store.putStream(await source.blob(d), d.mediaType, d);
    return object(JSON.parse(Buffer.from(await store.read(d)).toString()), "Base metadata");
  }
  async function select(d: Descriptor, depth: number): Promise<{ descriptor: Descriptor; manifest: ImageManifest }> {
    if (depth > 8) throw new Error("Base index nesting limit exceeded");
    const value = await metadata(d);
    if (value.schemaVersion !== 2 || (value.mediaType != null && value.mediaType !== d.mediaType)) throw new Error("Unsupported or inconsistent base manifest schema");
    if ([media.index, media.dockerIndex].includes(d.mediaType as typeof media.index)) {
      if (!Array.isArray(value.manifests)) throw new Error("Invalid base index");
      const candidates = value.manifests.map(descriptor).filter((child) => {
        if (child.artifactType) return false;
        if (!child.platform) return true;
        return child.platform.os === platform.os && child.platform.architecture === platform.architecture
          && (child.platform.variant ?? (child.platform.architecture === "arm64" ? "v8" : undefined)) === (platform.variant ?? (platform.architecture === "arm64" ? "v8" : undefined));
      });
      if (candidates.length !== 1) throw new Error(`Expected exactly one base for ${platform.os}/${platform.architecture}, found ${candidates.length}`);
      return select(candidates[0]!, depth + 1);
    }
    if (![media.manifest, media.dockerManifest].includes(d.mediaType as typeof media.manifest) || !Array.isArray(value.layers)) throw new Error("Unsupported base manifest type");
    const config = descriptor(value.config);
    if (![media.config, media.dockerConfig].includes(config.mediaType as typeof media.config)) throw new Error("Base is an artifact, not a runnable image");
    return { descriptor: d, manifest: { schemaVersion: 2, mediaType: d.mediaType, config, layers: value.layers.map(descriptor) } };
  }
  const selected = await select(root.descriptor, 0);
  const config = validateImageConfig(await metadata(selected.manifest.config), platform, selected.manifest.layers.length);
  const layers: Descriptor[] = [];
  for (const original of selected.manifest.layers) {
    if (![media.tar, media.gzip, media.dockerGzip].includes(original.mediaType as typeof media.tar)) throw new Error(`Unsupported base layer type: ${original.mediaType}`);
    if (lazy) store.defer(original, () => source.blob(original), source instanceof RegistrySource ? source.ref : undefined);
    else await store.putStream(await source.blob(original), original.mediaType, original);
    layers.push({ mediaType: original.mediaType === media.dockerGzip ? media.gzip : original.mediaType, digest: original.digest, size: original.size });
  }
  return {
    ...selected,
    manifest: { ...selected.manifest, layers },
    config,
    indexDigest: [media.index, media.dockerIndex].includes(root.descriptor.mediaType as typeof media.index) ? root.descriptor.digest : undefined,
  };
}

async function* ReadableBytes(bytes: Uint8Array) { yield bytes; }
