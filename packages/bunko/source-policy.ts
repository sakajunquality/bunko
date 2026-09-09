import ignore, { type Ignore } from "ignore";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/** Apply project-local gitignore rules without Git, host configuration, or index state. */
export function gitSourceIgnore(root: string): (path: string, directory?: boolean) => Promise<boolean> {
  const rules = new Map<string, Promise<Ignore | undefined>>();
  const results = new Map<string, Promise<boolean>>();
  let bytes = 0;
  function load(scope: string): Promise<Ignore | undefined> {
    if (!rules.has(scope)) rules.set(scope, (async () => {
      if (scope) {
        const directory = await lstat(join(root, scope));
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Source ignore scope must be a regular directory");
      }
      const path = join(root, scope, ".gitignore");
      let info;
      try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error("Source .gitignore must be a regular file of at most 256 KiB");
      const text = await Bun.file(path).slice(0, 256 * 1024 + 1).text(); bytes += Buffer.byteLength(text);
      if (Buffer.byteLength(text) > 256 * 1024 || bytes > 4 * 1024 * 1024) throw new Error("Source .gitignore rules exceed the size limit");
      return ignore({ ignorecase: false }).add(text);
    })());
    return rules.get(scope)!;
  }
  function check(path: string, directory = false): Promise<boolean> {
    if (!path || path === ".") return Promise.resolve(false);
    const key = path + (directory ? "/" : "");
    if (!results.has(key)) results.set(key, (async () => {
      const parent = dirname(path);
      // An excluded parent cannot be restored by a nested ignore file.
      if (parent !== "." && await check(parent, true)) return true;
      const parts = path.split("/"); let ignored = false;
      for (let depth = 0; depth < parts.length; depth++) {
        const scope = parts.slice(0, depth).join("/"), matcher = await load(scope);
        const result = matcher?.test(relative(scope || ".", path) + (directory ? "/" : ""));
        if (result?.ignored) ignored = true;
        else if (result?.unignored) ignored = false;
      }
      return ignored;
    })());
    return results.get(key)!;
  }
  return check;
}

/** Conservative PEM-marker rejection, including markers embedded in JSON strings. */
export async function assertNoSourcePrivateKey(file: string, path: string): Promise<void> {
  let tail = "";
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const text = tail + Buffer.from(chunk).toString("latin1");
    if (/-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----/.test(text)) throw new Error(`Private-key marker in source input: ${path}; remove the credential or exclude the file`);
    tail = text.slice(-128);
  }
}
