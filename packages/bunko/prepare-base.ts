import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { assertOutputAvailable, canonicalOutput, exportLayouts } from "../oci/layout.ts";
import { LayoutSource, RegistrySource, resolveBase } from "../oci/source.ts";
import type { RegistryOptions } from "../oci/registry.ts";
import { platform } from "./config.ts";

/** Persist complete, verified platform images for later --base-layout consumption. */
export async function prepareBase(options: { base?: string; baseLayout?: string; output: string; platform?: string; registry?: RegistryOptions }) {
  if (Boolean(options.base) === Boolean(options.baseLayout)) throw new Error("prepare-base requires exactly one of --base or --base-layout");
  const output = await canonicalOutput(options.output); await assertOutputAvailable(output);
  const platforms = [...new Set((options.platform ?? "linux/amd64").split(",").map((value) => value.trim()))].map(platform);
  const source = options.baseLayout ? new LayoutSource(options.baseLayout) : new RegistrySource(options.base!, options.registry);
  const root = await source.root(), directory = await mkdtemp(join(tmpdir(), "bunko-prepare-base-")), store = new BlobStore(directory);
  try {
    const images = [];
    for (const selected of platforms) {
      const base = await resolveBase({ root: async () => root, blob: source.blob.bind(source) }, selected, store);
      images.push({ source: store, root: { ...base.descriptor, platform: selected }, all: [base.manifest.config, ...base.manifest.layers], refName: `${selected.os}-${selected.architecture}` });
    }
    await exportLayouts(output, images);
    return { schemaVersion: 1, status: "prepared", sourceDigest: root.descriptor.digest, platforms: images.map((image) => ({ platform: image.root.platform, digest: image.root.digest })) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
