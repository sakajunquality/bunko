import { mkdtemp } from "../runtime/invocation.ts";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { assertOutputAvailable, canonicalOutput, exportLayouts } from "../oci/layout.ts";
import { LayoutSource, RegistrySource, resolveBase, type ImageSource } from "../oci/source.ts";
import type { RegistryOptions } from "../oci/registry.ts";
import { canonicalJSON } from "../oci/digest.ts";
import { media, type Descriptor, type Digest } from "../oci/types.ts";
import { platform } from "./config.ts";

/** Persist complete, verified platform images for later --base-layout consumption. */
export async function prepareBase(options: { base?: string; baseLayout?: string; output: string; platform?: string; registry?: RegistryOptions }) {
  if (Boolean(options.base) === Boolean(options.baseLayout)) throw new Error("prepare-base requires exactly one of --base or --base-layout");
  const output = await canonicalOutput(options.output); await assertOutputAvailable(output);
  const platforms = [...new Map((options.platform ?? "linux/amd64").split(",").map((value) => platform(value.trim())).map((value) => [`${value.os}/${value.architecture}/${value.variant ?? ""}`, value])).values()];
  const source = options.baseLayout ? new LayoutSource(options.baseLayout) : new RegistrySource(options.base!, options.registry);
  const root: Awaited<ReturnType<ImageSource["root"]>> = await (source instanceof LayoutSource ? source.baseRoot() : source.root()), directory = await mkdtemp(join(tmpdir(), "bunko-prepare-base-")), store = new BlobStore(directory);
  try {
    const images = [];
    const downloaded = new Map<Digest, Descriptor>();
    const pinned = { root: async () => root, blob: async (descriptor: Descriptor) => {
      downloaded.set(descriptor.digest, descriptor);
      return source.blob(descriptor);
    } };
    for (const selected of platforms) {
      const base = await resolveBase(pinned, selected, store);
      images.push({ source: store, root: { ...base.descriptor, platform: selected }, all: [base.manifest.config, ...base.manifest.layers], refName: `${selected.os}-${selected.architecture}` });
    }
    // Preserve the source index bytes, including references to unselected graphs.
    // Only the selected graphs are materialized; unavailable platforms stay offline errors.
    const index = root.layout ? await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests: images.map((image) => image.root) }), media.index) : root.descriptor;
    await exportLayouts(output, [{ source: store, root: index, all: [...downloaded.values()], refName: `bunko.local/prepared-base:sha256-${root.descriptor.digest.slice(7)}` }]);
    return { schemaVersion: 1, status: "prepared", sourceDigest: root.descriptor.digest, platforms: images.map((image) => ({ platform: image.root.platform, digest: image.root.digest })) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
