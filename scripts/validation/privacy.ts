import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createGunzip } from "node:zlib";

/** Exact identifier gate, not a general secret detector or artifact redactor. */
export async function scanPrivateOutput(root: string, terms: string[], maxBytes = 1024 ** 3): Promise<{ files: number; bytes: number }> {
  if (!terms.length || terms.some((term) => typeof term !== "string" || term.length < 3 || term.length > 1024 || /[^\x20-\x7e]/.test(term))) throw new Error("INVALID_PRIVACY_TERMS");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("INVALID_SCAN_LIMIT");
  root = resolve(root);
  const needles = terms.flatMap((term) => [term, encodeURIComponent(term), JSON.stringify(term).slice(1, -1)].flatMap((value) => [Buffer.from(value.toLowerCase()), Buffer.from(value.toLowerCase(), "utf16le")]));
  const carrySize = Math.max(...needles.map((item) => item.length)) - 1;
  let bytes = 0, files = 0;
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
    const magic = Buffer.from(await Bun.file(file).slice(0, 4).arrayBuffer());
    if (magic.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])) || magic.subarray(0, 2).toString() === "PK") throw new Error("UNSUPPORTED_COMPRESSED_OUTPUT");
    const raw = createReadStream(file);
    try { await scan(raw); } finally { raw.destroy(); }
    if (magic.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) {
      const source = createReadStream(file), decoded = createGunzip();
      source.on("error", () => decoded.destroy(new Error("OUTPUT_SCAN_FAILED")));
      try { await scan(source.pipe(decoded)); } finally { source.destroy(); decoded.destroy(); }
    }
  }
  async function walk(path: string) {
    const info = await lstat(path);
    if (path === root && !info.isDirectory() && !info.isSymbolicLink()) throw new Error("OUTPUT_FILE_TYPE_REJECTED");
    if (info.isSymbolicLink()) throw new Error("OUTPUT_SYMLINK_REJECTED");
    check(Buffer.from(path === root ? "" : path.slice(root.length)));
    if (info.isDirectory()) for (const child of (await readdir(path)).sort()) await walk(join(path, child));
    else if (info.isFile()) { files++; await content(path); }
    else throw new Error("OUTPUT_FILE_TYPE_REJECTED");
  }
  try { await walk(root); return { files, bytes }; }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/^(?:PRIVATE_IDENTIFIER_DETECTED|UNSUPPORTED_COMPRESSED_OUTPUT|OUTPUT_(?:SCAN_LIMIT_EXCEEDED|SYMLINK_REJECTED|FILE_TYPE_REJECTED))$/.test(message)) throw error;
    throw new Error("OUTPUT_SCAN_FAILED");
  }
}
