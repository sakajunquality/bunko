import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

/** Exact identifier gate, not a general secret detector or artifact redactor. */
export async function scanPrivateOutput(root: string, terms: string[], maxBytes = 1024 ** 3): Promise<{ files: number; bytes: number }> {
  if (!terms.length || terms.some((term) => typeof term !== "string" || term.length < 3 || term.length > 1024 || /[^\x20-\x7e]/.test(term))) throw new Error("INVALID_PRIVACY_TERMS");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("INVALID_SCAN_LIMIT");
  root = resolve(root);
  const needles = terms.flatMap((term) => [term, encodeURIComponent(term), JSON.stringify(term).slice(1, -1)].flatMap((value) => [Buffer.from(value.toLowerCase()), Buffer.from(value.toLowerCase(), "utf16le")]));
  const carrySize = Math.max(...needles.map((item) => item.length)) - 1;
  let bytes = 0, files = 0;
  const observed = new Map<string, string>();
  const identity = (info: BigIntStats) => [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":");
  async function unchanged(path: string) {
    if (identity(await lstat(path, { bigint: true })) !== observed.get(path)) throw new Error("OUTPUT_CHANGED_DURING_SCAN");
  }
  function check(value: Buffer) {
    const lower = Buffer.from(value);
    for (let i = 0; i < lower.length; i++) if (lower[i]! >= 65 && lower[i]! <= 90) lower[i] = lower[i]! + 32;
    if (needles.some((term) => lower.includes(term))) throw new Error("PRIVATE_IDENTIFIER_DETECTED");
  }
  async function scan(stream: AsyncIterable<Buffer | string>) {
    let carry = Buffer.alloc(0);
    for await (const part of stream) {
      const chunk = Buffer.from(part); bytes += chunk.length;
      if (bytes > maxBytes) throw new Error("OUTPUT_SCAN_LIMIT_EXCEEDED");
      const combined = Buffer.concat([carry, chunk]); check(combined);
      carry = combined.subarray(Math.max(0, combined.length - carrySize));
    }
  }
  async function content(file: string) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (identity(await handle.stat({ bigint: true })) !== observed.get(file)) throw new Error("OUTPUT_CHANGED_DURING_SCAN");
      const header = Buffer.alloc(512), { bytesRead } = await handle.read(header, 0, 512, 0);
      const magic = header.subarray(0, bytesRead);
      if (magic.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])) || magic.subarray(0, 2).toString() === "PK" || magic.subarray(257, 262).toString() === "ustar") throw new Error("UNSUPPORTED_COMPRESSED_OUTPUT");
      async function* chunks() {
        const buffer = Buffer.alloc(64 * 1024);
        let position = 0;
        while (true) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) return;
          position += bytesRead;
          yield Buffer.from(buffer.subarray(0, bytesRead));
        }
      }
      await scan(chunks());
      if (magic.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) {
        const source = Readable.from(chunks()), decoded = createGunzip();
        source.on("error", () => decoded.destroy(new Error("OUTPUT_SCAN_FAILED")));
        try { await scan(source.pipe(decoded)); } finally { source.destroy(); decoded.destroy(); }
      }
      if (identity(await handle.stat({ bigint: true })) !== observed.get(file)) throw new Error("OUTPUT_CHANGED_DURING_SCAN");
    } finally { await handle.close(); }
  }
  async function walk(path: string) {
    const info = await lstat(path, { bigint: true });
    observed.set(path, identity(info));
    if (path === root && !info.isDirectory() && !info.isSymbolicLink()) throw new Error("OUTPUT_FILE_TYPE_REJECTED");
    if (info.isSymbolicLink()) throw new Error("OUTPUT_SYMLINK_REJECTED");
    check(Buffer.from(path === root ? "" : path.slice(root.length)));
    if (info.isDirectory()) for (const child of (await readdir(path)).sort()) await walk(join(path, child));
    else if (info.isFile()) { files++; await content(path); }
    else throw new Error("OUTPUT_FILE_TYPE_REJECTED");
    await unchanged(path);
  }
  try { await walk(root); for (const path of observed.keys()) await unchanged(path); return { files, bytes }; }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/^(?:PRIVATE_IDENTIFIER_DETECTED|UNSUPPORTED_COMPRESSED_OUTPUT|OUTPUT_(?:CHANGED_DURING_SCAN|SCAN_LIMIT_EXCEEDED|SYMLINK_REJECTED|FILE_TYPE_REJECTED))$/.test(message)) throw error;
    throw new Error("OUTPUT_SCAN_FAILED");
  }
}
