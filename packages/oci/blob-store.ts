import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertDigest, sha256 } from "./digest.ts";
import type { Descriptor, Digest } from "./types.ts";

export class BlobStore {
  constructor(readonly root: string) { }

  path(digest: Digest): string {
    assertDigest(digest);
    return join(this.root, "blobs", "sha256", digest.slice(7));
  }

  async put(bytes: Uint8Array, mediaType: string): Promise<Descriptor> {
    return this.putStream(Readable.from([bytes]), mediaType, {
      digest: sha256(bytes), size: bytes.byteLength, mediaType,
    });
  }

  async putStream(
    stream: AsyncIterable<Uint8Array>,
    mediaType: string,
    expected?: Descriptor,
  ): Promise<Descriptor> {
    await mkdir(join(this.root, "blobs", "sha256"), { recursive: true });
    const temporary = join(this.root, "blobs", `.tmp-${randomUUID()}`);
    const hash = createHash("sha256");
    let size = 0;
    async function* checked() {
      for await (const chunk of stream) {
        size += chunk.byteLength;
        if (expected && size > expected.size) throw new Error(`Blob size mismatch: ${expected.digest}`);
        hash.update(chunk);
        yield chunk;
      }
    }
    try {
      await pipeline(Readable.from(checked()), createWriteStream(temporary, { flags: "wx" }));
      const digest: Digest = `sha256:${hash.digest("hex")}`;
      if (expected && (digest !== expected.digest || size !== expected.size)) {
        throw new Error(`Blob digest/size mismatch: expected ${expected.digest}, received ${digest}`);
      }
      await rename(temporary, this.path(digest));
      return { mediaType, digest, size };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async read(d: Descriptor, limit = 8 * 1024 * 1024): Promise<Uint8Array> {
    if (d.size > limit) throw new Error(`Metadata exceeds ${limit} bytes: ${d.digest}`);
    const bytes = new Uint8Array(await Bun.file(this.path(d.digest)).arrayBuffer());
    if (bytes.byteLength !== d.size || sha256(bytes) !== d.digest) {
      throw new Error(`Blob digest/size mismatch: ${d.digest}`);
    }
    return bytes;
  }

  async copyFrom(source: BlobStore, d: Descriptor): Promise<void> {
    const info = await stat(source.path(d.digest));
    if (info.size !== d.size) throw new Error(`Blob size mismatch: ${d.digest}`);
    await this.putStream(createReadStream(source.path(d.digest)), d.mediaType, d);
  }
}
