import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { sha256 } from "./digest.ts";
import type { BlobStore } from "./blob-store.ts";
import { media, type Digest, type Layer } from "./types.ts";

export type FileMode = 0o444 | 0o555 | 0o644 | 0o755;

export type TarEntry =
  | { path: string; type: "directory" }
  | { path: string; type: "symlink"; target: string }
  | { path: string; type: "file"; executable?: boolean; mode?: FileMode; content: Uint8Array }
  | { path: string; type: "file"; executable?: boolean; mode?: FileMode; source: string; size: number };

export function archivePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path)
    || path.split("/").some((p) => !p || p === "." || p === ".." || p.startsWith(".wh."))) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(path)}`);
  }
  return path;
}

function entriesWithParents(input: TarEntry[]): TarEntry[] {
  const entries = new Map<string, TarEntry>();
  const caseNames = new Map<string, string>();
  function add(entry: TarEntry, implicit = false) {
    archivePath(entry.path);
    const lower = entry.path.toLowerCase();
    if (caseNames.has(lower) && caseNames.get(lower) !== entry.path) {
      throw new Error(`Case-colliding archive path: ${entry.path}`);
    }
    caseNames.set(lower, entry.path);
    const existing = entries.get(entry.path);
    if (existing && (existing.type !== "directory" || entry.type !== "directory")) {
      throw new Error(`Overlapping archive path: ${entry.path}`);
    }
    if (!existing || !implicit) entries.set(entry.path, entry);
  }
  for (const entry of input) {
    add(entry);
    let parent = posix.dirname(entry.path);
    while (parent !== ".") {
      add({ path: parent, type: "directory" }, true);
      parent = posix.dirname(parent);
    }
    if (entry.type === "symlink") {
      if (!entry.target || posix.isAbsolute(entry.target) || /[\\\x00-\x1f\x7f]/.test(entry.target)) {
        throw new Error(`Unsafe symlink: ${entry.path}`);
      }
      const target = posix.normalize(posix.join(posix.dirname(entry.path), entry.target));
      if (target === ".." || target.startsWith("../")) throw new Error(`Escaping symlink: ${entry.path}`);
    }
  }
  return [...entries.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

function octal(header: Buffer, start: number, width: number, value: number) {
  const encoded = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || encoded.length >= width) throw new Error("Tar number overflow");
  header.write(`${encoded.padStart(width - 1, "0")}\0`, start, width, "ascii");
}

function splitPath(path: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
    const prefix = path.slice(0, slash), name = path.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { prefix, name };
  }
}

function header(path: { name: string; prefix: string }, type: string, size: number, mode: number, epoch: number, target = ""): Buffer {
  const result = Buffer.alloc(512);
  result.write(path.name, 0, 100, "utf8");
  octal(result, 100, 8, mode);
  octal(result, 108, 8, 0);
  octal(result, 116, 8, 0);
  octal(result, 124, 12, size);
  octal(result, 136, 12, epoch);
  result.fill(0x20, 148, 156);
  result.write(type, 156, 1, "ascii");
  result.write(target, 157, 100, "utf8");
  result.write("ustar\0", 257, 6, "ascii");
  result.write("00", 263, 2, "ascii");
  result.write(path.prefix, 345, 155, "utf8");
  const sum = result.reduce((a, b) => a + b, 0);
  result.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return result;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (length !== Buffer.byteLength(body) + String(length).length) {
    length = Buffer.byteLength(body) + String(length).length;
  }
  return Buffer.from(`${length}${body}`);
}

const padding = (size: number) => Buffer.alloc((512 - size % 512) % 512);

export async function* tar(input: TarEntry[], epoch: number): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Invalid tar epoch");
  for (const entry of entriesWithParents(input)) {
    const path = splitPath(entry.path);
    const size = entry.type === "file" ? ("content" in entry ? entry.content.byteLength : entry.size) : 0;
    const target = entry.type === "symlink" ? entry.target : "";
    const pax: Buffer[] = [];
    if (!path) pax.push(paxRecord("path", entry.path));
    if (Buffer.byteLength(target) > 100) pax.push(paxRecord("linkpath", target));
    if (size >= 8 ** 11) pax.push(paxRecord("size", String(size)));
    if (epoch >= 8 ** 11) pax.push(paxRecord("mtime", String(epoch)));
    if (pax.length) {
      const bytes = Buffer.concat(pax);
      yield header({ name: `PaxHeaders/${sha256(entry.path).slice(7, 39)}`, prefix: "" }, "x", bytes.length, 0o644, 0);
      yield bytes;
      yield padding(bytes.length);
    }
    const type = entry.type === "directory" ? "5" : entry.type === "symlink" ? "2" : "0";
    if (entry.type === "file" && entry.mode !== undefined && ![0o444, 0o555, 0o644, 0o755].includes(entry.mode)) throw new Error("Unsupported archive file mode");
    const mode = entry.type === "directory" ? 0o755 : entry.type === "symlink" ? 0o777 : entry.mode ?? (entry.executable ? 0o755 : 0o644);
    yield header(path ?? { name: "PaxEntry", prefix: "" }, type, size < 8 ** 11 ? size : 0, mode,
      epoch < 8 ** 11 ? epoch : 0, Buffer.byteLength(target) <= 100 ? target : "");
    if (entry.type === "file") {
      if ("content" in entry) {
        yield entry.content;
      } else {
        let read = 0;
        for await (const chunk of createReadStream(entry.source)) {
          read += chunk.length;
          if (read > size) throw new Error(`File changed while packing: ${entry.path}`);
          yield chunk;
        }
        if (read !== size) throw new Error(`File changed while packing: ${entry.path}`);
      }
      yield padding(size);
    }
  }
  yield Buffer.alloc(1024);
}

export async function packLayer(store: BlobStore, entries: TarEntry[], kind: Layer["kind"], epoch: number): Promise<Layer | undefined> {
  if (entries.length === 0) return undefined;
  const hash = createHash("sha256");
  async function* hashedTar() {
    for await (const chunk of tar(entries, epoch)) { hash.update(chunk); yield chunk; }
  }
  // Fixed gzip envelope, including the portable OS=255 byte.
  const input = Readable.from(hashedTar());
  const gzip = createGzip({ level: 6 });
  const compression = pipeline(input, gzip);
  // Attach a rejection handler immediately, before the blob store creates its file.
  // The pipeline may fail before normalizedGzip starts consuming it.
  void compression.catch(() => { });
  async function* normalizedGzip() {
    let prefix = Buffer.alloc(0);
    let started = false;
    for await (const chunk of gzip) {
      if (started) { yield chunk as Buffer; continue; }
      prefix = Buffer.concat([prefix, chunk as Buffer]);
      if (prefix.length >= 10) {
        prefix.fill(0, 4, 8);
        prefix[9] = 255;
        started = true;
        yield prefix;
        prefix = Buffer.alloc(0);
      }
    }
    if (!started) throw new Error("Incomplete gzip stream");
  }
  try {
    const descriptor = await store.putStream(normalizedGzip(), media.gzip);
    await compression;
    const diffId: Digest = `sha256:${hash.digest("hex")}`;
    return { kind, descriptor, diffId };
  } finally {
    input.destroy();
    gzip.destroy();
    await compression.catch(() => { });
  }
}
