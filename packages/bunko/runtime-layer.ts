import { mkdtemp } from "../runtime/invocation.ts";
import { runtimeNotices } from "./runtime-notices.ts";
import { canonicalJSON } from "../oci/digest.ts";
import { extract } from "tar-stream";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { join, posix } from "node:path";
import { decodeLayer } from "../oci/decode.ts";
import { packLayer, type TarEntry } from "../oci/tar.ts";
import type { BlobStore } from "../oci/blob-store.ts";
import type { BaseImage } from "../oci/types.ts";
import type { InjectedRuntime } from "./runtime-download.ts";

export interface BaseNode { type: string; link?: string; mode: number; size: number; layer?: number; muslSearchPath?: string }
/** Receives every non-whiteout entry of one layer; the stream may be consumed, and is drained otherwise.
 * Directories a layer only implies carry no stream and are reported once, when they enter the tree. */
export type LayerCapture = (index: number, path: string, node: BaseNode, stream?: Readable) => Promise<void>;
export type BaseFilesystem = Map<string, BaseNode>;
/** Normalizes a layer entry name the way container runtimes do: leading `/` and `./` prefixes are dropped (ko and
 * some tar writers emit absolute names such as `/ko-app/tool`); traversal, empty segments, backslashes and control
 * characters remain rejected. Exported for tests. */
export function layerPath(value: string): string {
  if (Buffer.byteLength(value) > 8192) throw new Error("Base filesystem path exceeds inspection limits");
  const name = value.replace(/^(\/+|\.\/)+/, "").replace(/\/$/, "");
  if (!name || name === ".") return "";
  if (Buffer.byteLength(name) > 4096 || name.split("/").length > 128) throw new Error("Base filesystem path exceeds inspection limits");
  if (/[\\\x00-\x1f\x7f]/.test(name) || name.split("/").some((p) => !p || p === ".." || p === ".")) throw new Error(`Unsupported path in runtime base filesystem: ${JSON.stringify(value.slice(0, 200)).replace(/\x7f/g, "\\u007f")}`);
  return name;
}
const pathName = layerPath;
function ancestors(path: string) { const parts = path.split("/"); return parts.map((_, i) => parts.slice(0, i + 1).join("/")); }

/** Inspect metadata without extracting or following paths on the build host. */
export async function baseFilesystem(store: BlobStore, base: BaseImage, temporary: string): Promise<BaseFilesystem> {
  const tree = await applyLayers(store, base, temporary, async (_index, path, node, stream) => {
    if (!/^etc\/ld-musl-(?:x86_64|aarch64)\.path$/.test(path) || node.type !== "file" || !stream || node.size > 4096) return;
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 4096) throw new Error("musl library search configuration exceeds inspection limits");
      chunks.push(bytes);
    }
    node.muslSearchPath = Buffer.concat(chunks).toString("utf8");
  });
  for (const node of tree.values()) delete node.layer;
  return tree;
}

/** Apply every layer in order, resolving whiteouts, and optionally capture selected entry bodies.
 * Captured nodes record their winning layer index so callers can materialize the merged result. */
export async function applyLayers(store: BlobStore, base: BaseImage, temporary: string, capture?: LayerCapture, entryLimit = 200_000): Promise<BaseFilesystem> {
  if (!Number.isSafeInteger(entryLimit) || entryLimit < 1 || entryLimit > 200_000) throw new Error("Invalid base filesystem entry limit");
  const tree: BaseFilesystem = new Map(); let count = 0;
  const directory = await mkdtemp(join(temporary, "base-inspect-"));
  try {
    for (const [index, descriptor] of base.manifest.layers.entries()) {
      const file = join(directory, `${index}.tar`);
      const overlay: BaseFilesystem = new Map(), removed = new Set<string>(), opaque = new Set<string>();
      try {
        await decodeLayer(store, descriptor, base.config.rootfs.diff_ids[index]!, file);
        const tar = extract();
        tar.on("entry", (header, stream, next) => {
          stream.on("error", (error) => tar.destroy(error));
          const body = stream as unknown as Readable;
          (async () => {
            if (++count > entryLimit) throw new Error("Runtime base has too many entries");
            const path = pathName(header.name), leaf = posix.basename(path), parent = posix.dirname(path);
            if (path) {
              if (leaf === ".wh..wh..opq") opaque.add(parent === "." ? "" : parent);
              else if (leaf.startsWith(".wh.")) removed.add(parent === "." ? leaf.slice(4) : `${parent}/${leaf.slice(4)}`);
              else {
                const node: BaseNode = { type: header.type ?? "file", link: header.linkname, mode: header.mode ?? 0, size: header.size ?? 0, ...(capture ? { layer: index } : {}) };
                overlay.set(path, node);
                await capture?.(index, path, node, body);
              }
            }
            if (!body.readableEnded) for await (const chunk of body) void chunk;
          })().then(() => next(), (error) => { body.destroy(error as Error); tar.destroy(error as Error); });
        });
        await pipeline(createReadStream(file), tar);
        for (const path of tree.keys()) {
          const chain = ancestors(path);
          if (opaque.has("") || chain.some((p) => removed.has(p)) || chain.slice(0, -1).some((p) => opaque.has(p) || overlay.has(p) && overlay.get(p)!.type !== "directory")) tree.delete(path);
        }
        for (const [path, entry] of overlay) tree.set(path, entry);
        // Layers may omit headers for directories they populate. Fill those in against the effective tree,
        // after whiteouts, so a directory a whiteout removed and this layer repopulates exists again. A
        // surviving non-directory is never replaced: a lower symlink parent must stay visible so consumers
        // reject it instead of resolving through it. Only an explicit header or whiteout can displace it.
        for (const path of overlay.keys()) for (const parent of ancestors(path).slice(0, -1)) {
          if (tree.has(parent)) continue;
          if (++count > entryLimit) throw new Error("Runtime base has too many entries");
          const node: BaseNode = { type: "directory", mode: 0o755, size: 0, ...(capture ? { layer: index } : {}) };
          tree.set(parent, node);
          await capture?.(index, parent, node);
        }
      } finally { await rm(file, { force: true }); }
    }
    return tree;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Resolve image links in memory, never against the host filesystem. */
export function baseNode(tree: BaseFilesystem, absolute: string): BaseNode | undefined {
  let path = pathName(absolute.replace(/^\//, ""));
  for (let hops = 0; hops < 40; hops++) {
    const chain = ancestors(path); let followed = false;
    for (const [index, part] of chain.entries()) {
      const entry = tree.get(part);
      if (entry && (entry.type === "symlink" || entry.type === "link")) {
        if (!entry.link || /[\\\x00-\x1f\x7f]/.test(entry.link)) throw new Error("Invalid link in runtime base");
        const target = entry.link.startsWith("/") ? entry.link : `/${entry.type === "link" ? "" : posix.dirname(part) + "/"}${entry.link}`;
        path = pathName(posix.normalize(target + (index < chain.length - 1 ? `/${path.slice(part.length + 1)}` : "")).slice(1));
        followed = true; break;
      }
      if (index < chain.length - 1 && entry && entry.type !== "directory") return undefined;
    }
    if (!followed) return tree.get(path);
  }
  throw new Error("Runtime base contains a link cycle");
}

export function assertRuntimeBase(metadata: InjectedRuntime, tree: BaseFilesystem, libraryPath = ""): void {
  const loader = baseNode(tree, metadata.interpreter);
  if (!loader || loader.type !== "file" || !loader.size || !(loader.mode & 0o111)) throw new Error(`Runtime base is missing the executable ${metadata.libc} loader ${metadata.interpreter}; this base cannot run the selected release`);
  if (metadata.libc !== "musl") return;
  const configPath = `/etc/${posix.basename(metadata.interpreter).replace(".so.1", ".path")}`;
  const config = baseNode(tree, configPath);
  if (config && (config.type !== "file" || config.muslSearchPath === undefined)) throw new Error(`Cannot inspect musl library search configuration ${configPath}; use a regular file of at most 4096 bytes at this path`);
  const paths = `${libraryPath}:${config?.muslSearchPath ?? "/lib:/usr/local/lib:/usr/lib"}`.split(/[:\n]/).filter(Boolean);
  if (paths.some((path) => !path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path))) throw new Error("musl library search paths must be absolute paths without control characters");
  for (const name of metadata.needed) {
    // musl's interpreter also provides its libc SONAME, even without a sibling symlink.
    if (name === "libc.so" || name === posix.basename(metadata.interpreter).replace("ld-", "libc.")) continue;
    const found = paths.some((directory) => { const node = baseNode(tree, posix.join(directory, name)); return node?.type === "file" && node.size > 0; });
    if (!found) throw new Error(`musl runtime base is missing ${name}; install the runtime libraries (Alpine typically needs libstdc++) before injection`);
  }
}

export function runtimeEntries(metadata: InjectedRuntime, executable: Buffer, tree: BaseFilesystem, libraryPath = ""): TarEntry[] {
  const path = pathName(metadata.path.slice(1));
  if (!path || metadata.path !== `/${path}`) throw new Error("Invalid runtime injection destination");
  for (const parent of ancestors(path).slice(0, -1)) {
    const entry = tree.get(parent);
    if (entry && entry.type !== "directory") throw new Error("Runtime destination has a non-directory or symlink parent in the base");
  }
  const existing = tree.get(path);
  if (existing && existing.type !== "file") throw new Error("Runtime destination overlaps a non-regular base entry");
  assertRuntimeBase(metadata, tree, libraryPath);
  return [{ path, type: "file", content: executable, executable: true }];
}

export async function injectedLayer(store: BlobStore, metadata: InjectedRuntime, executable: Buffer, tree: BaseFilesystem, epoch: number, libraryPath = "") {
  const entries = runtimeEntries(metadata, executable, tree, libraryPath);
  const notice = runtimeNotices[metadata.version];
  if (!notice) throw new Error("Missing injected runtime licensing notices");
  for (const [path, content] of [["/usr/share/licenses/bunko-runtime/LICENSE.md", notice], ["/usr/share/licenses/bunko-runtime/SOURCE.json", canonicalJSON({ version: metadata.version, revision: metadata.releaseRevision, source: `https://github.com/oven-sh/bun/tree/${metadata.releaseRevision}`, archive: metadata.url, archiveDigest: metadata.archiveDigest })]] as const) {
    const files = runtimeEntries({ ...metadata, path }, Buffer.from(content), tree, libraryPath);
    entries.push(...files.map((entry) => ({ ...entry, executable: false })));
  }
  return { entries, layer: (await packLayer(store, entries, "runtime", epoch, []))! };
}
