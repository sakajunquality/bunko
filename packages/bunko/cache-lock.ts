import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** A cooperating-process lock protects key/blob readers from pruning. Crashed
 * locks are never broken automatically: recovery requires inspecting the owner. */
export async function withCacheLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
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
