import { randomUUID } from "node:crypto";
import { cacheMutexProtocol, withCacheMutex } from "./cache-mutex.ts";
import { hostname } from "node:os";
import { pause } from "../runtime/invocation.ts";
import { lstat, mkdir, rm, readFile, realpath, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

/** A cooperating-process lock serializes writers and pruning. Readers verify
 * copied blobs and treat concurrent deletion as a cache miss. New-format crashed
 * locks can be recovered only while holding their matching OS-backed mutex. */
const queues = new Map<string, Promise<void>>();
export async function withCacheLock<T>(directory: string, operation: () => Promise<T>, enabled: () => boolean = () => true, waitMilliseconds = 10_000): Promise<T> {
  if (!enabled()) throw new Error("Cache persistence disabled for this invocation");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Cache must be a real directory");
  const key = await realpath(resolve(directory)), previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => { release = done; });
  queues.set(key, current);
  await previous;
  try { if (!enabled()) throw new Error("Cache persistence disabled for this invocation"); return await lockDirectory(key, operation, waitMilliseconds); }
  finally { release(); if (queues.get(key) === current) queues.delete(key); }
}
async function lockDirectory<T>(directory: string, operation: () => Promise<T>, waitMilliseconds: number): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error("Cache must be a real directory");
  const lock = join(directory, ".bunko-lock");
  const deadline = Date.now() + Math.min(waitMilliseconds, 5 * 60_000);
  return withCacheMutex(directory, deadline, async (identity) => {
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readOwner(lock);
      if (owner?.schemaVersion === 2 && owner.protocol === cacheMutexProtocol && owner.mutexIdentity === identity && await deadLocalOwner(lock)) {
        // Require both the matching OS mutex and a dead owner on this host.
        // Legacy writers never remove a lock they did not acquire.
        const recovered = `${lock}.recovered-${randomUUID()}`;
        await rename(lock, recovered);
        await rm(recovered, { recursive: true });
        continue;
      }
      if (await deadLocalOwner(lock)) throw new Error(`Cache lock has a dead local owner: ${lock}. Stop all cache users and inspect the lock before manual recovery; no lock was deleted.`);
      if (Date.now() >= deadline) throw new Error(`Cache is locked by another operation: ${lock}; inspect its owner before recovering a crashed process`);
      await pause(50);
    }
  }
  try { await Bun.write(join(lock, "owner.json"), JSON.stringify({ schemaVersion: 2, protocol: cacheMutexProtocol, mutexIdentity: identity, pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() })); return await operation(); }
  finally { await rm(lock, { recursive: true, force: true }); }
  });
}

async function readOwner(lock: string): Promise<Record<string, unknown> | undefined> {
  try {
    const info = await lstat(lock), file = join(lock, "owner.json"), ownerInfo = await lstat(file);
    if (!info.isDirectory() || info.isSymbolicLink() || !ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.size > 4096) return;
    const owner = JSON.parse(await readFile(file, "utf8"));
    return owner && typeof owner === "object" && !Array.isArray(owner) ? owner : undefined;
  } catch { return; }
}

/** Liveness is diagnostic only: a PID check cannot authorize race-free lock deletion. */
async function deadLocalOwner(lock: string): Promise<boolean> {
  try {
    const info = await lstat(lock), file = join(lock, "owner.json"), ownerInfo = await lstat(file);
    if (!info.isDirectory() || info.isSymbolicLink() || !ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.size > 4096) return false;
    const owner = JSON.parse(await readFile(file, "utf8"));
    if (![1, 2].includes(owner.schemaVersion) || owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch { return false; }
}
