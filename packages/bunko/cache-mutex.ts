import { Database, constants as sqlite } from "bun:sqlite";
import { chmod, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pause } from "../runtime/invocation.ts";

export const cacheMutexProtocol = "sqlite-exclusive-v1";
export class CacheMutexBusyError extends Error {}
export const cacheMutexFile = ".bunko-lock.sqlite";

/** SQLite's OS lock is released on process death. No cache metadata is stored in
 * this database and no transaction is committed. Never unlink this lock inode. */
export async function withCacheMutex<T>(directory: string, deadline: number, task: (identity: string) => Promise<T>): Promise<T> {
  const path = join(await realpath(directory), cacheMutexFile);
  const inspect = async () => {
    try {
      const info = await lstat(path, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 4096n) throw new Error("Invalid cache mutex file");
      return `${info.dev}:${info.ino}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  };
  const before = await inspect();
  // Do not independently open/close this file: POSIX closes can release another
  // SQLite connection's process-wide locks. Let SQLite own every descriptor.
  const database = new Database(path, sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_CREATE | sqlite.SQLITE_OPEN_NOFOLLOW);
  let identity: string;
  try {
    const after = await inspect();
    if (!after || before && before !== after) throw new Error("Cache mutex file changed while opening");
    identity = after;
    await chmod(path, 0o600);
    for (;;) {
      try {
        // MEMORY avoids journal/WAL sidecars and untrusted sidecar path traversal.
        database.exec("PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE");
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
        if (Date.now() >= deadline) throw new CacheMutexBusyError(`Cache is locked by another operation: ${join(directory, ".bunko-lock")}`);
        await pause(50);
      }
    }
    return await task(identity);
  } finally { database.close(); }
}
