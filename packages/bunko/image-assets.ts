import { filesystemMetadata } from "./ignore.ts";
import { writeAssetBytes } from "./asset-write.ts";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { canonicalJSON, object, sha256 } from "../oci/digest.ts";
import type { RegistryOptions } from "../oci/registry.ts";
import { RegistrySource, resolveBase } from "../oci/source.ts";
import { archivePath, type FileMode, type TarEntry } from "../oci/tar.ts";
import type { BaseImage, Digest, Platform } from "../oci/types.ts";
import { assetMode } from "./asset-policy.ts";
import { withCacheLock } from "./cache-lock.ts";
import { platform as parsePlatform } from "./platforms.ts";
import { applyLayers } from "./runtime-layer.ts";

/** Bounds on the selected content. Each layer is separately bounded while decoding, so peak
 * extraction disk follows the source image's layers, not these numbers. */
export const imageAssetLimit = 512 * 1024 ** 2, imageAssetEntryLimit = 20_000, imageManifestLimit = 8 * 1024 ** 2;
export interface ImageAssetOptions {
  platform: Platform; registry?: RegistryOptions; cache?: string; offline?: boolean; reproducible?: boolean;
  limit?: number; entryLimit?: number; stage: string; temporary: string; log?: (message: string) => void;
}
interface ContentEntry { path: string; type: "file" | "directory"; executable?: boolean; size?: number; digest?: Digest }
interface ContentManifest { schemaVersion: 1; resolved: Digest; from: string; mode: string | null; entries: ContentEntry[] }

/** Materialize the merged view of `from`, so whiteouts and later layers win exactly as they would in a runtime. */
async function extractImagePath(store: BlobStore, image: BaseImage, from: string, content: string, layers: string, temporary: string, limit: number, entryLimit: number): Promise<void> {
  const selected = archivePath(from.slice(1)), parts = selected.split("/");
  const inside = (path: string) => path === selected || path.startsWith(`${selected}/`);
  let bytes = 0, count = 0;
  // Whiteouts anywhere above the selection can remove it, so every layer is applied in order.
  const tree = await applyLayers(store, image, temporary, async (index, path, node, stream) => {
    if (!inside(path)) return;
    // Every selected entry counts once when it appears: directories, implied parent directories, and
    // versions a later layer replaces or deletes. The bound is on extraction work, so it never decreases.
    if (++count > entryLimit) throw new Error("Image asset selection has too many entries");
    if (node.type !== "file" || !stream) return;
    const file = join(layers, String(index), path);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(file, "wx", 0o600);
    try {
      for await (const chunk of stream) {
        bytes += (chunk as Uint8Array).byteLength;
        if (bytes > limit) throw new Error("Image asset selection exceeds the extraction size limit");
        await writeAssetBytes(handle, chunk as Uint8Array);
      }
    } finally { await handle.close(); }
  });
  // Never traverse a link out of the selected subtree; the caller must name the resolved path.
  for (const [i] of parts.entries()) {
    const node = tree.get(parts.slice(0, i + 1).join("/"));
    if (i < parts.length - 1 && node && node.type !== "directory") throw new Error(`Image asset path traverses a link or non-directory: ${from}`);
  }
  const paths = [...tree.keys()].filter(inside).sort();
  const root = tree.get(selected);
  if (!root || !paths.length) throw new Error(`Missing image asset input: ${from}`);
  if (paths.length > entryLimit) throw new Error("Image asset selection has too many entries");
  // A file that a later layer populated through without replacing it is inconsistent; never silently drop its children.
  if (root.type === "file" && paths.length > 1) throw new Error(`Image asset path is a file with entries beneath it: ${from}`);
  for (const path of paths) {
    const type = tree.get(path)!.type;
    if (type !== "file" && type !== "directory") throw new Error(`Unsupported image asset entry type (${type}): /${path}`);
  }
  await mkdir(dirname(content), { recursive: true, mode: 0o700 });
  // Executable classification is the only permission bit carried forward; contents stay owner-only in the cache.
  if (root.type === "file") { await rename(join(layers, String(root.layer), selected), content); await chmod(content, root.mode & 0o111 ? 0o700 : 0o600); return; }
  await mkdir(content, { recursive: true, mode: 0o700 });
  for (const path of paths.slice(1)) {
    const node = tree.get(path)!, target = join(content, path.slice(selected.length + 1));
    if (node.type === "directory") { await mkdir(target, { recursive: true, mode: 0o700 }); continue; }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rename(join(layers, String(node.layer), path), target);
    await chmod(target, node.mode & 0o111 ? 0o700 : 0o600);
  }
}

/** Copy the shared cache entry into private build staging through one descriptor per file, recording or
 * re-checking a digest for every entry. Nothing outside `staging` is read again after this returns. */
async function snapshotContent(content: string, staging: string, limit: number, entryLimit: number, expected?: ContentEntry[]): Promise<ContentEntry[]> {
  const entries: ContentEntry[] = [];
  let total = 0;
  async function walk(source: string, path: string, target: string) {
    const info = await lstat(source);
    if (info.isDirectory()) {
      if (entries.length >= entryLimit) throw new Error("Image asset selection has too many entries");
      await mkdir(target, { recursive: true, mode: 0o700 });
      entries.push({ path, type: "directory" });
      for (const name of (await readdir(source)).sort()) await walk(join(source, name), path ? `${path}/${name}` : name, join(target, name));
      return;
    }
    if (!info.isFile()) throw new Error(`Unsupported image asset entry type: ${path || "."}`);
    if (entries.length >= entryLimit) throw new Error("Image asset selection has too many entries");
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw new Error("Image asset cache entry is not a regular file");
      const output = await open(target, "wx", opened.mode & 0o111 ? 0o700 : 0o600), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
      let size = 0;
      try {
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
          if (!bytesRead) break;
          size += bytesRead; total += bytesRead;
          if (total > limit) throw new Error("Image asset selection exceeds the extraction size limit");
          hash.update(buffer.subarray(0, bytesRead));
          await writeAssetBytes(output, buffer.subarray(0, bytesRead));
        }
      } finally { await output.close(); }
      entries.push({ path, type: "file", executable: Boolean(opened.mode & 0o111), size, digest: `sha256:${hash.digest("hex")}` });
    } finally { await handle.close(); }
  }
  await mkdir(dirname(staging), { recursive: true, mode: 0o700 });
  await walk(content, "", staging);
  if (expected && Buffer.compare(Buffer.from(canonicalJSON(entries)), Buffer.from(canonicalJSON(expected)))) throw new Error("Image asset cache content does not match its recorded manifest");
  return entries;
}

async function readManifest(path: string, resolved: Digest, from: string, mode: string | null): Promise<ContentManifest | undefined> {
  try {
    const file = Bun.file(path);
    if (file.size > imageManifestLimit) throw new Error("Image asset manifest exceeds size limit");
    const value = object(JSON.parse(await file.text()), "Image asset manifest");
    if (value.schemaVersion !== 1 || value.resolved !== resolved || value.from !== from || (value.mode ?? null) !== mode || !Array.isArray(value.entries)) throw new Error("Image asset manifest does not describe this selection");
    return value as unknown as ContentManifest;
  } catch { return undefined; }
}

function assetEntries(entries: ContentEntry[], staging: string, destination: string, mode: FileMode | undefined, validate: (path: string) => void): TarEntry[] {
  return entries.filter((entry) => !filesystemMetadata(entry.path)).map((entry) => {
    const path = entry.path ? `${destination}/${entry.path}` : destination;
    validate(path);
    if (entry.type === "directory") return { type: "directory", path };
    return { type: "file", path, source: entry.path ? join(staging, entry.path) : staging, size: entry.size ?? 0, ...(mode !== undefined ? { mode } : {}), executable: Boolean((mode ?? (entry.executable ? 0o755 : 0o644)) & 0o111) };
  });
}

/** Copy one file or directory out of another image, the way `COPY --from` does, without running it. */
export async function stageImageAsset(mapping: { image: string; from: string; to: string; mode?: string; platform?: string }, options: ImageAssetOptions, validate: (path: string) => void): Promise<{ entries: TarEntry[]; resolved: Digest }> {
  if (options.offline) throw new Error("Offline builds cannot resolve image asset sources; stage the files into a directory bound with --asset-context");
  if (options.reproducible && !/@sha256:[a-f0-9]{64}$/.test(mapping.image)) throw new Error("--reproducible requires image asset sources pinned to a sha256 digest");
  const selected = mapping.platform ? parsePlatform(mapping.platform) : options.platform;
  await mkdir(options.temporary, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(options.temporary, "image-asset-"));
  try {
    const store = new BlobStore(join(work, "store")), source = new RegistrySource(mapping.image, options.registry ?? {});
    // Layers stay deferred so a cached extraction resolves the digest without transferring any of them.
    const image = await resolveBase(source, selected, store, true);
    const resolved = image.descriptor.digest, mode = mapping.mode ?? null;
    // Extraction is cached by resolved digest, selection and mode, so unchanged sources never pull layers again.
    const key = sha256(canonicalJSON({ kind: "bunko/image-asset/v1", image: resolved, from: mapping.from, mode }));
    const directory = join(options.cache ?? join(options.stage, "cache"), "images", key.slice(7));
    const staging = join(options.stage, "content"), limit = options.limit ?? imageAssetLimit, entryLimit = options.entryLimit ?? imageAssetEntryLimit;
    const captured = await withCacheLock(directory, async () => {
      const manifest = join(directory, "manifest.json"), content = join(directory, "content");
      const recorded = await readManifest(manifest, resolved, mapping.from, mode);
      if (recorded) {
        try { return await snapshotContent(content, staging, limit, entryLimit, recorded.entries); }
        catch { options.log?.(`Image asset cache entry failed verification; extracting a verified replacement\n`); }
        await rm(staging, { recursive: true, force: true });
      }
      await rm(manifest, { force: true });
      await rm(content, { recursive: true, force: true });
      options.log?.(`Extracting ${mapping.from} from ${mapping.image} (${resolved})\n`);
      await extractImagePath(store, image, mapping.from, content, join(work, "layers"), work, limit, entryLimit);
      const entries = await snapshotContent(content, staging, limit, entryLimit);
      const staged = join(directory, `.manifest-${randomUUID()}`);
      try {
        await writeFile(staged, canonicalJSON({ schemaVersion: 1, resolved, from: mapping.from, mode, entries } satisfies ContentManifest), { mode: 0o600, flag: "wx" });
        await rename(staged, manifest);
      } finally { await rm(staged, { force: true }); }
      return entries;
    }, () => true, 35 * 60_000);
    return { entries: assetEntries(captured, staging, mapping.to.slice(1), assetMode(mapping.mode), validate), resolved };
  } finally { await rm(work, { recursive: true, force: true }); }
}
