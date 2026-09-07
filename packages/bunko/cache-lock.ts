import { lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/** A cooperating-process lock serializes writers and pruning. Readers verify
 * copied blobs and treat concurrent deletion as a cache miss. Crashed
 * locks are never broken automatically: recovery requires inspecting the owner. */
const queues = new Map<string, Promise<void>>();
export async function withCacheLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(directory), previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => { release = done; });
  queues.set(key, current);
  await previous;
  try { return await lockDirectory(directory, operation); }
  finally { release(); if (queues.get(key) === current) queues.delete(key); }
}
async function lockDirectory<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error("Cache must be a real directory");
  const lock = join(directory, ".bunko-lock");
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt >= 200) throw new Error("Cache is locked by another operation; inspect .bunko-lock before recovering a crashed process");
      await Bun.sleep(50);
    }
  }
  try { await Bun.write(join(lock, "owner.json"), JSON.stringify({ pid: process.pid })); return await operation(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
