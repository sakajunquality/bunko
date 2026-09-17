import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { CacheMutexBusyError, cacheMutexFile, cacheMutexProtocol, withCacheMutex } from "./cache-mutex.ts";

export const cacheTemporaryName = /^\.tmp-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const stageName = /^\.bunko-stage-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const residueMinimumAge = 3600_000;

/** No PID-only reclamation: both the dead local owner and its matching exclusive
 * lease are required. Missing/foreign/uncertain owners are retained. */
async function deadOwner(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const info = await lstat(join(path, "owner.json"));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return;
    const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
    if (owner?.schemaVersion !== 1 || owner.kind !== "layer-cache-stage" || owner.protocol !== cacheMutexProtocol || owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return;
    try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return owner; }
  } catch { /* Uncertain ownership is retained. */ }
}

/** Count only the bounded tree emitted by a stage writer. Do not follow links. */
async function stageBytes(path: string): Promise<number | undefined> {
  let bytes = 0, entries = 0;
  async function walk(relative: string): Promise<boolean> {
    for (const name of await readdir(join(path, relative))) {
      if (++entries > 32) return false;
      const key = relative ? `${relative}/${name}` : name;
      const info = await lstat(join(path, key));
      if (info.isSymbolicLink()) return false;
      if (["blobs", "blobs/sha256"].includes(key)) { if (!info.isDirectory() || !await walk(key)) return false; }
      else {
        if (!info.isFile() || info.nlink !== 1 || !(key === "owner.json" || key === cacheMutexFile || /^blobs\/sha256\/[a-f0-9]{64}$/.test(key) || relative === "blobs" && cacheTemporaryName.test(name))) return false;
        bytes += info.size;
      }
    }
    return true;
  }
  return await walk("") ? bytes : undefined;
}

/** Called under the cache metadata lock. Lease probes must never wait: a live
 * stage writer may already be waiting for that metadata lock to publish. */
export async function pruneStages(directory: string, cutoff: number, execute: boolean): Promise<{ bytes: number; paths: string[] }> {
  const result = { bytes: 0, paths: [] as string[] };
  for (const name of (await readdir(directory)).sort()) {
    if (!stageName.test(name)) continue;
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.mtimeMs > cutoff) continue;
      const owner = await deadOwner(path);
      if (!owner) continue;
      // Never create a replacement mutex for an incomplete stage.
      const mutex = await lstat(join(path, cacheMutexFile));
      if (!mutex.isFile() || mutex.isSymbolicLink()) continue;
      await withCacheMutex(path, Date.now(), async (identity) => {
        if (owner.mutexIdentity !== identity || (await deadOwner(path))?.mutexIdentity !== identity) return;
        const bytes = await stageBytes(path);
        if (bytes === undefined) return;
        if (execute) await rm(path, { recursive: true });
        result.bytes += bytes; result.paths.push(path);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof CacheMutexBusyError) continue;
      throw error;
    }
  }
  return result;
}
