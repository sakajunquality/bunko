import { basename, extname } from "node:path";

const roots = ["usr/share/fonts", "usr/local/share/fonts"];
export function systemFontPath(path: string): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** Font namespaces accept regular, non-executable font data and accompanying notices. */
export function fontFileKind(path: string, mode: number, size: number): "font" | "notice" {
  if (roots.includes(path) || mode & 0o111) throw new Error("System font mappings require non-executable files below a font directory");
  if (/\.(ttf|otf|ttc|otc)$/i.test(path)) {
    if (size < 12 || size > 128 * 1024 * 1024) throw new Error("System font file must be between 12 bytes and 128 MiB");
    return "font";
  }
  if (/^(?:OFL|LICENSE|LICENCE|COPYING|NOTICE|README)(?:[._-][a-z0-9._-]+)?$/i.test(basename(path)) && size <= 1024 * 1024) return "notice";
  throw new Error("System font mappings only accept TTF, OTF, TTC, OTC and license/notice files");
}

/** Check bounded SFNT directories; this is format validation, not a font sanitizer. */
export async function validateFontFile(file: string, destination: string, mode: number): Promise<void> {
  const input = Bun.file(file), size = input.size;
  if (fontFileKind(destination, mode, size) === "notice") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await input.arrayBuffer());
      if (text.includes("\0")) throw new Error();
    } catch { throw new Error("System font license/notice files must be UTF-8 text without NUL bytes"); }
    return;
  }
  const invalid = () => new Error("Invalid system font SFNT data");
  async function bytes(offset: number, length: number): Promise<Buffer> {
    if (offset < 0 || offset + length > size) throw invalid();
    const data = Buffer.from(await input.slice(offset, offset + length).arrayBuffer());
    if (data.length !== length) throw invalid();
    return data;
  }
  const header = await bytes(0, 12), collection = [".ttc", ".otc"].includes(extname(destination).toLowerCase());
  let offsets = [0];
  if (collection) {
    const count = header.readUInt32BE(8);
    if (header.readUInt32BE(0) !== 0x74746366 || ![0x10000, 0x20000].includes(header.readUInt32BE(4)) || count < 1 || count > 64) throw invalid();
    const directory = await bytes(12, count * 4);
    offsets = Array.from({ length: count }, (_, index) => directory.readUInt32BE(index * 4));
    if (offsets.some((offset) => offset < 12 + count * 4)) throw invalid();
  }
  for (const offset of offsets) {
    const header = await bytes(offset, 12), version = header.readUInt32BE(0), count = header.readUInt16BE(4);
    if (![0x10000, 0x4f54544f, 0x74727565].includes(version) || count < 1 || count > 4096) throw invalid();
    const directory = await bytes(offset + 12, count * 16), tags = new Set<string>();
    for (let index = 0; index < count; index++) {
      const position = index * 16, tag = directory.toString("latin1", position, position + 4);
      const start = directory.readUInt32BE(position + 8), length = directory.readUInt32BE(position + 12);
      if (tags.has(tag) || !/^[\x20-\x7e]{4}$/.test(tag) || start < 12 || start + length > size || (["head", "name", "cmap"].includes(tag) && length === 0)) throw invalid();
      tags.add(tag);
    }
    if (!["head", "name", "cmap"].every((tag) => tags.has(tag))) throw invalid();
  }
}
