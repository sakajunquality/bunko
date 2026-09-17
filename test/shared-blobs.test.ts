import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { sharedBlobs } from "../packages/oci/shared-blobs.ts";
import { temporary } from "./helpers.ts";

test("shared downloads verify bytes, coalesce concurrent readers and recover after corruption", async () => {
  const directory = await temporary();
  try {
    const bytes = Buffer.from("verified"), descriptor = { digest: sha256(bytes), size: bytes.length, mediaType: "application/octet-stream" };
    let calls = 0, corrupt = true;
    const source = { root: async () => ({ descriptor, bytes }), blob: async () => {
      calls++; await Bun.sleep(10);
      return (async function* () { yield corrupt ? Buffer.from("corrupt!") : bytes; })();
    } };
    const get = sharedBlobs(new BlobStore(directory));
    const failed = await Promise.allSettled([get(source, descriptor), get(source, descriptor)]);
    expect(failed.every((result) => result.status === "rejected")).toBe(true); expect(calls).toBe(1);
    corrupt = false;
    const streams = await Promise.all([get(source, descriptor), get(source, descriptor)]);
    for (const stream of streams) {
      const chunks: Uint8Array[] = []; for await (const chunk of stream) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(bytes);
    }
    expect(calls).toBe(2);
    await expect(get(source, { ...descriptor, size: bytes.length + 1 })).rejects.toThrow("Conflicting blob sizes");
    await get(source, descriptor); expect(calls).toBe(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
