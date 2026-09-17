import { randomUUID } from "node:crypto";
import { lstat, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const cacheLayoutFile = "bunko-cache.json";
const layout = { schemaVersion: 1, layoutVersion: 1, minReader: 1 };
/** minReader is the layout-reader protocol, not the CLI package version. An absent
 * envelope is the legacy v1 layout. Call with the metadata lock for writes. */
export async function cacheLayout(directory: string, create = false): Promise<boolean> {
  const path = join(directory, cacheLayoutFile);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("Invalid cache layout metadata");
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || ![value.schemaVersion, value.layoutVersion, value.minReader].every((version) => Number.isSafeInteger(version) && version > 0)) throw new Error("Invalid cache layout metadata");
    return value.schemaVersion === 1 && value.layoutVersion === 1 && value.minReader === 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (create) {
      const temporary = join(directory, `.tmp-layout-${randomUUID()}`);
      try { await writeFile(temporary, JSON.stringify(layout) + "\n", { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
    }
    return true;
  }
}
