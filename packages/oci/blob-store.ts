import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertDigest, sha256 } from "./digest.ts";
import type { Descriptor, Digest } from "./types.ts";

export class BlobStore {
  constructor(readonly root: string, private readonly onMaterialize?: (descriptor: Descriptor, task: () => Promise<void>) => Promise<void>) { }
  readonly origins = new Map<Digest, { registry: string; repository: string }>();
  private readonly pending = new Map<Digest, () => Promise<AsyncIterable<Uint8Array>>>();
  private readonly inflight = new Map<Digest, Promise<void>>();

  defer(d: Descriptor, materialize: () => Promise<AsyncIterable<Uint8Array>>, origin?: { registry: string; repository: string }) {
    this.pending.set(d.digest, materialize);
    if (origin) this.origins.set(d.digest, origin);
  }

  async ensure(d: Descriptor): Promise<void> {
    const materialize = this.pending.get(d.digest);
    if (!materialize) return;
    let work = this.inflight.get(d.digest);
    if (!work) {
      const load = async () => {
        await this.putStream(await materialize(), d.mediaType, d);
        this.pending.delete(d.digest);
      };
      work = this.onMaterialize ? this.onMaterialize(d, load) : load();
      this.inflight.set(d.digest, work);
    }
    try { await work; } finally { this.inflight.delete(d.digest); }
  }

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
    await this.ensure(d);
    const bytes = new Uint8Array(await Bun.file(this.path(d.digest)).arrayBuffer());
    if (bytes.byteLength !== d.size || sha256(bytes) !== d.digest) {
      throw new Error(`Blob digest/size mismatch: ${d.digest}`);
    }
    return bytes;
  }

  async copyFrom(source: BlobStore, d: Descriptor): Promise<void> {
    await source.ensure(d);
    const info = await stat(source.path(d.digest));
    if (info.size !== d.size) throw new Error(`Blob size mismatch: ${d.digest}`);
    await this.putStream(createReadStream(source.path(d.digest)), d.mediaType, d);
  }
}
