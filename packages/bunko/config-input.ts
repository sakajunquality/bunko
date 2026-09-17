import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/** Inspect repository configuration before parsing; never read a symlink target. */
export async function readConfigInput(root: string, path: string): Promise<string> {
  const base = await realpath(root), local = relative(base, resolve(base, path));
  if (!local || local === ".." || local.startsWith("../")) throw new Error("Configuration must stay inside its project");
  let current = base;
  const parts = local.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error("Configuration input must be a regular file without symlink ancestors");
  }
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("Configuration input exceeds the regular-file size limit");
    const buffer = Buffer.alloc(info.size + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await file.read(buffer, length, buffer.length - length); if (!bytesRead) break; length += bytesRead; }
    if (length === buffer.length) throw new Error("Configuration input exceeds the regular-file size limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}

/** Parser diagnostics may include source contents; only expose the configuration kind. */
export function parseConfigInput<T>(text: string, kind: string, parse: (text: string) => T): T {
  try { return parse(text); } catch { throw new Error(`Invalid ${kind} configuration`); }
}
