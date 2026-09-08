import { runtimeNotices } from "./runtime-notices.ts";
import { canonicalJSON } from "../oci/digest.ts";
import { extract } from "tar-stream";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join, posix } from "node:path";
import { decodeLayer } from "../oci/decode.ts";
import { packLayer, type TarEntry } from "../oci/tar.ts";
import type { BlobStore } from "../oci/blob-store.ts";
import type { BaseImage } from "../oci/types.ts";
import type { InjectedRuntime } from "./runtime-download.ts";

export interface BaseNode { type: string; link?: string; mode: number; size: number }
export type BaseFilesystem = Map<string, BaseNode>;
function pathName(value: string): string {
  const name = value.replace(/^(\.\/)+/, "").replace(/\/$/, "");
  if (!name || name === ".") return "";
  if (name.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(name) || name.split("/").some((p) => !p || p === ".." || p === ".")) throw new Error("Unsupported path in runtime base filesystem");
  return name;
}
function ancestors(path: string) { const parts = path.split("/"); return parts.map((_, i) => parts.slice(0, i + 1).join("/")); }

/** Inspect metadata without extracting or following paths on the build host. */
export async function baseFilesystem(store: BlobStore, base: BaseImage, temporary: string): Promise<BaseFilesystem> {
  const tree: BaseFilesystem = new Map(); let count = 0;
  for (const [index, descriptor] of base.manifest.layers.entries()) {
    const file = join(temporary, `runtime-base-${index}.tar`);
    const overlay: BaseFilesystem = new Map(), removed = new Set<string>(), opaque = new Set<string>();
    try {
      await decodeLayer(store, descriptor, base.config.rootfs.diff_ids[index]!, file);
      const tar = extract();
      tar.on("entry", (header, stream, next) => {
        try {
          if (++count > 200_000) throw new Error("Runtime base has too many entries");
          const path = pathName(header.name), leaf = posix.basename(path), parent = posix.dirname(path);
          if (path) {
            if (leaf === ".wh..wh..opq") opaque.add(parent === "." ? "" : parent);
            else if (leaf.startsWith(".wh.")) removed.add(parent === "." ? leaf.slice(4) : `${parent}/${leaf.slice(4)}`);
            else overlay.set(path, { type: header.type ?? "file", link: header.linkname, mode: header.mode ?? 0, size: header.size ?? 0 });
          }
          stream.on("end", next); stream.resume();
        } catch (error) { stream.destroy(error as Error); tar.destroy(error as Error); }
      });
      await pipeline(createReadStream(file), tar);
      for (const path of tree.keys()) {
        const chain = ancestors(path);
        if (opaque.has("") || chain.some((p) => removed.has(p)) || chain.slice(0, -1).some((p) => opaque.has(p) || overlay.has(p) && overlay.get(p)!.type !== "directory")) tree.delete(path);
      }
      for (const [path, entry] of overlay) tree.set(path, entry);
    } finally { await rm(file, { force: true }); }
  }
  return tree;
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

export function runtimeEntries(metadata: InjectedRuntime, executable: Buffer, tree: BaseFilesystem): TarEntry[] {
  const path = pathName(metadata.path.slice(1));
  if (!path || metadata.path !== `/${path}`) throw new Error("Invalid runtime injection destination");
  for (const parent of ancestors(path).slice(0, -1)) {
    const entry = tree.get(parent);
    if (entry && entry.type !== "directory") throw new Error("Runtime destination has a non-directory or symlink parent in the base");
  }
  const existing = tree.get(path);
  if (existing && existing.type !== "file") throw new Error("Runtime destination overlaps a non-regular base entry");
  const loader = baseNode(tree, metadata.interpreter);
  if (!loader || loader.type !== "file" || !loader.size || !(loader.mode & 0o111)) throw new Error(`Runtime base is missing the executable glibc loader ${metadata.interpreter}; static/musl bases cannot run this release`);
  return [{ path, type: "file", content: executable, executable: true }];
}

export async function injectedLayer(store: BlobStore, metadata: InjectedRuntime, executable: Buffer, tree: BaseFilesystem, epoch: number) {
  const entries = runtimeEntries(metadata, executable, tree);
  const notice = runtimeNotices[metadata.version];
  if (!notice) throw new Error("Missing injected runtime licensing notices");
  for (const [path, content] of [["/usr/share/licenses/bunko-runtime/LICENSE.md", notice], ["/usr/share/licenses/bunko-runtime/SOURCE.json", canonicalJSON({ version: metadata.version, revision: metadata.releaseRevision, source: `https://github.com/oven-sh/bun/tree/${metadata.releaseRevision}`, archive: metadata.url, archiveDigest: metadata.archiveDigest })]] as const) {
    const files = runtimeEntries({ ...metadata, path }, Buffer.from(content), tree);
    entries.push(...files.map((entry) => ({ ...entry, executable: false })));
  }
  return { entries, layer: (await packLayer(store, entries, "runtime", epoch, entries.map((entry) => entry.path)))! };
}
