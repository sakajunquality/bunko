import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { BlobStore } from "./blob-store.ts";
import { media, type Descriptor, type Digest } from "./types.ts";

/** Validate the uncompressed DiffID even when the compressed CAS digest is valid. */
export async function decodeLayer(store: BlobStore, d: Descriptor, diffId: Digest, output?: string): Promise<void> {
  await store.ensure(d);
  const hash = createHash("sha256");
  const meter = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  const source = createReadStream(store.path(d.digest));
  const destination = output ? createWriteStream(output, { flags: "wx" }) : new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  if (d.mediaType === media.gzip || d.mediaType === media.dockerGzip) await pipeline(source, createGunzip(), meter, destination);
  else if (d.mediaType === media.tar) await pipeline(source, meter, destination);
  else throw new Error(`Cannot decode layer media type: ${d.mediaType}`);
  if (`sha256:${hash.digest("hex")}` !== diffId) throw new Error(`Layer DiffID mismatch: ${d.digest}`);
}
