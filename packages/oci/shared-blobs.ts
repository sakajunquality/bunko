import { createReadStream } from "node:fs";
import { BlobStore } from "./blob-store.ts";
import type { ImageSource } from "./source.ts";
import type { Descriptor, Digest } from "./types.ts";

/** Invocation-scoped, verified base downloads shared by independently built targets. */
export function sharedBlobs(store: BlobStore) {
  const pending = new Map<Digest, { size: number; ready: Promise<void> }>();
  return async (source: ImageSource, descriptor: Descriptor): Promise<AsyncIterable<Uint8Array>> => {
    let entry = pending.get(descriptor.digest);
    if (entry && entry.size !== descriptor.size) throw new Error(`Conflicting blob sizes: ${descriptor.digest}`);
    if (!entry) {
      const ready = (async () => {
        await store.putStream(await source.blob(descriptor), descriptor.mediaType, descriptor);
      })();
      entry = { size: descriptor.size, ready };
      pending.set(descriptor.digest, entry);
    }
    try { await entry.ready; }
    catch (error) {
      if (pending.get(descriptor.digest) === entry) pending.delete(descriptor.digest);
      throw error;
    }
    return (async function* () { yield* createReadStream(store.path(descriptor.digest)); })();
  };
}
