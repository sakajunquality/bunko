import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { BlobStore } from "./blob-store.ts";
import { canonicalJSON } from "./digest.ts";
import { media, type Descriptor } from "./types.ts";

/** Resolve existing parents, while retaining the final path for symlink checks. */
export async function canonicalOutput(path: string): Promise<string> {
  const absolute = resolve(path);
  let parent = dirname(absolute);
  const suffix = [basename(absolute)];
  while (true) {
    try { return join(await realpath(parent), ...suffix); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(parent) === parent) throw error;
      suffix.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}

export async function assertOutputAvailable(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(path)).length) {
      throw new Error(`Output already exists or is not an empty directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function exportLayout(source: BlobStore, output: string, root: Descriptor, all: Descriptor[], refName: string): Promise<void> {
  return exportLayouts(output, [{ source, root, all, refName }]);
}

export async function exportLayouts(output: string, images: { source: BlobStore; root: Descriptor; all: Descriptor[]; refName: string }[]): Promise<void> {
  output = resolve(output);
  await assertOutputAvailable(output);
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), ".bunko-layout-"));
  try {
    const destination = new BlobStore(temporary);
    const copied = new Set<string>();
    for (const { source, root, all } of images) for (const d of [...all, root]) {
      if (copied.has(d.digest)) continue;
      await destination.copyFrom(source, d);
      copied.add(d.digest);
    }
    await writeFile(join(temporary, "oci-layout"), canonicalJSON({ imageLayoutVersion: "1.0.0" }));
    await writeFile(join(temporary, "index.json"), canonicalJSON({
      schemaVersion: 2, mediaType: media.index,
      manifests: images.flatMap(({ root, refName, all }) => [{ ...root, annotations: { "org.opencontainers.image.ref.name": refName } }, ...all.filter((d) => d.artifactType)]),
    }));
    await assertOutputAvailable(output);
    // rename replaces an empty directory, but cannot overwrite a non-empty directory.
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}
