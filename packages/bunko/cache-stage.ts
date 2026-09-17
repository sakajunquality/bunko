import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import type { Descriptor } from "../oci/types.ts";
import { cacheMutexProtocol, withCacheMutex } from "./cache-mutex.ts";

/** Copy and authenticate outside the shared metadata lock, on the same filesystem
 * as the destination. A separate lease protects this private staging directory. */
export async function withStagedCacheBlob<T>(directory: string, source: BlobStore, descriptor: Descriptor, publish: (path: string) => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Cache must be a real directory");
  const stage = join(directory, `.bunko-stage-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    return await withCacheMutex(stage, Date.now(), async (identity) => {
      await writeFile(join(stage, "owner.json"), JSON.stringify({ schemaVersion: 1, kind: "layer-cache-stage", protocol: cacheMutexProtocol, mutexIdentity: identity, hostname: hostname(), pid: process.pid }), { flag: "wx", mode: 0o600 });
      const store = new BlobStore(stage);
      await store.copyFrom(source, descriptor);
      return publish(store.path(descriptor.digest));
    });
  } finally { await rm(stage, { recursive: true, force: true }); }
}
