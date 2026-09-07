import { mkdir, open, realpath, symlink } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { assertOutputAvailable } from "./layout.ts";
import { archivePath } from "./tar.ts";

/** Extract only the strict ustar/PAX subset produced by bunko. Links are created
 * after regular files, and every parent is reserved before any filesystem write. */
export async function extractDependencies(file: string, destination: string, prefix: string, maxBytes = 2 * 1024 ** 3): Promise<void> {
  archivePath(prefix);
  await assertOutputAvailable(destination);
  const input = await open(file, "r");
  const links: { path: string; target: string }[] = [];
  const entries = new Map<string, string>(), spelling = new Map<string, string>();
  let offset = 0, count = 0, total = 0, zero = 0;
  let pax: Record<string, string> = {};
  const reserve = (path: string, type: string, implicit = false) => {
    const lower = path.toLowerCase();
    if (spelling.has(lower) && spelling.get(lower) !== path) throw new Error("Case-colliding dependency archive");
    spelling.set(lower, path);
    const old = entries.get(path);
    if (old && !(old === "5" && type === "5" && implicit)) throw new Error("Overlapping dependency archive path");
    if (!old) entries.set(path, type);
  };
  const bytes = async (size: number) => {
    const buffer = Buffer.alloc(size);
    let used = 0;
    while (used < size) {
      const { bytesRead } = await input.read(buffer, used, size - used, offset);
      if (!bytesRead) throw new Error("Truncated dependency tar");
      used += bytesRead; offset += bytesRead;
    }
    return buffer;
  };
  const number = (buffer: Buffer) => {
    const value = buffer.toString("ascii").replace(/\0.*$/, "").trim();
    if (!/^[0-7]+$/.test(value)) throw new Error("Unsupported tar numeric encoding");
    const result = parseInt(value, 8);
    if (!Number.isSafeInteger(result)) throw new Error("Tar numeric overflow");
    return result;
  };
  const text = (buffer: Buffer) => {
    const end = buffer.indexOf(0), raw = end < 0 ? buffer : buffer.subarray(0, end);
    const value = raw.toString("utf8");
    if (!Buffer.from(value).equals(raw)) throw new Error("Tar name is not UTF-8");
    return value;
  };
  try {
    await mkdir(destination, { recursive: true });
    const root = await realpath(destination);
    while (true) {
      const header = await bytes(512);
      if (header.every((b) => b === 0)) { if (++zero === 2) break; continue; }
      if (zero) throw new Error("Invalid tar end marker");
      if (++count > 200_000) throw new Error("Dependency tar has too many entries");
      const expected = number(header.subarray(148, 156));
      const checked = Buffer.from(header); checked.fill(32, 148, 156);
      if (checked.reduce((sum, value) => sum + value, 0) !== expected || text(header.subarray(257, 263)) !== "ustar") throw new Error("Invalid ustar header");
      const type = String.fromCharCode(header[156]!);
      let size = number(header.subarray(124, 136));
      if (type === "x") {
        if (size > 64 * 1024 || Object.keys(pax).length) throw new Error("Invalid PAX extension");
        const data = await bytes(size);
        for (let cursor = 0; cursor < data.length;) {
          const space = data.indexOf(32, cursor);
          const length = Number(data.subarray(cursor, space).toString());
          if (space < cursor || !Number.isSafeInteger(length) || length <= space - cursor + 1 || cursor + length > data.length || data[cursor + length - 1] !== 10) throw new Error("Invalid PAX record");
          const record = data.subarray(space + 1, cursor + length - 1);
          if (record.includes(0)) throw new Error("NUL in PAX record");
          const row = text(record);
          const equal = row.indexOf("="), key = row.slice(0, equal);
          if (equal < 1 || !["path", "linkpath", "size", "mtime"].includes(key) || key in pax) throw new Error("Unsupported PAX key");
          pax[key] = row.slice(equal + 1); cursor += length;
        }
        await bytes((512 - size % 512) % 512);
        continue;
      }
      if (pax.size !== undefined) { if (!/^\d+$/.test(pax.size)) throw new Error("Invalid PAX size"); size = Number(pax.size); }
      if (!Number.isSafeInteger(size) || size < 0 || (total += size) > maxBytes) throw new Error("Dependency tar exceeds size limit");
      const name = text(header.subarray(0, 100)), parent = text(header.subarray(345, 500));
      const path = archivePath(pax.path ?? (parent ? `${parent}/${name}` : name));
      const target = pax.linkpath ?? text(header.subarray(157, 257)); pax = {};
      if (!["0", "5", "2"].includes(type) || type !== "0" && size) throw new Error("Unsupported dependency tar entry");
      if (!(path === prefix || path.startsWith(`${prefix}/`) || type === "5" && prefix.startsWith(`${path}/`))) throw new Error("Dependency tar escapes its destination");
      // A directory explicitly emitted after an implicit parent is harmless.
      reserve(path, type, type === "5");
      for (let parent = posix.dirname(path); parent !== "."; parent = posix.dirname(parent)) reserve(parent, "5", true);
      const output = join(root, path);
      await mkdir(dirname(output), { recursive: true });
      if (type === "5") await mkdir(output, { recursive: true });
      else if (type === "2") {
        if (!target || posix.isAbsolute(target) || /[\\\x00-\x1f\x7f]/.test(target)) throw new Error("Unsafe dependency symlink");
        const resolved = posix.normalize(posix.join(posix.dirname(path), target));
        if (resolved !== prefix && !resolved.startsWith(`${prefix}/`)) throw new Error("Dependency symlink escapes node_modules");
        links.push({ path, target });
      } else {
        const mode = number(header.subarray(100, 108));
        const handle = await open(output, "wx", mode & 0o111 ? 0o755 : 0o644);
        try {
          let position = 0;
          for (let remaining = size; remaining > 0;) {
            const chunk = await bytes(Math.min(64 * 1024, remaining));
            for (let used = 0; used < chunk.length;) {
              const { bytesWritten } = await handle.write(chunk, used, chunk.length - used, position);
              if (!bytesWritten) throw new Error("Dependency extraction write made no progress");
              used += bytesWritten; position += bytesWritten;
            }
            remaining -= chunk.length;
          }
        }
        finally { await handle.close(); }
        await bytes((512 - size % 512) % 512);
      }
    }
    if (Object.keys(pax).length) throw new Error("Dangling PAX extension");
    const length = (await input.stat()).size;
    while (offset < length) if (!(await bytes(Math.min(64 * 1024, length - offset))).every((b) => b === 0)) throw new Error("Data after tar end marker");
    for (const link of links) await symlink(link.target, join(root, link.path));
    const modules = join(root, prefix);
    for (const link of links) {
      const target = await realpath(join(root, link.path)), local = relative(modules, target);
      if (local === ".." || local.startsWith("../")) throw new Error("Dependency symlink resolves outside node_modules");
    }
  } finally { await input.close(); }
}
