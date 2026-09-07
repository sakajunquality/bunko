import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { decodeLayer } from "../oci/decode.ts";
import { assertDigest, canonicalJSON, descriptor, object, sha256 } from "../oci/digest.ts";
import { Publisher, repositoryName } from "../oci/publish.ts";
import { RegistryError, type RegistryOptions } from "../oci/registry.ts";
import { RegistrySource } from "../oci/source.ts";
import { media, type Digest, type Layer, type Platform } from "../oci/types.ts";
import { hashFile } from "./files.ts";
import { withCacheLock } from "./cache-lock.ts";
import { mapFiles } from "./concurrency.ts";
import type { TarEntry } from "../oci/tar.ts";
import type { InventoryEntry, NativeBinary } from "./deps.ts";

const configMedia = "application/vnd.bunko.cache.config.v1+json";
const artifactMedia = "application/vnd.bunko.cache.v1";
export const packFormat = `tar-gzip-v1/bun-${Bun.version}-${Bun.revision}`;
export interface CacheRecord {
  schemaVersion: 1; key: Digest; kind: "deps" | "assets"; packFormat: string;
  destination: string; platform: Platform | null; layer: Layer;
  inventory: InventoryEntry[]; native: NativeBinary[];
}
export interface CacheEvent { kind: "deps" | "assets"; key: Digest; status: "local" | "registry" | "miss" | "bypass" }
export function cacheKey(inputs: unknown): Digest { return sha256(Buffer.concat([Buffer.from("bunko/cache/v1\0"), Buffer.from(canonicalJSON(inputs))])); }
export function cacheTag(kind: string, key: Digest) { assertDigest(key); return `bunko-cache-v1-${kind}-${key.slice(7)}`; }

export async function assetInputs(entries: TarEntry[]): Promise<unknown> {
  return mapFiles(entries, async (entry) => entry.type === "file" ? {
    type: entry.type, path: entry.path, executable: Boolean(entry.executable), digest: "source" in entry ? await hashFile(entry.source) : sha256(entry.content),
  } : entry);
}

export class LayerCache {
  readonly events: CacheEvent[] = [];
  private readonly remoteHits = new Set<Digest>();
  private readonly records = new Map<Digest, CacheRecord>();
  private readonly local?: BlobStore;
  private readonly remote?: Publisher;
  constructor(readonly store: BlobStore, private readonly options: { directory?: string; repository?: string; registry?: RegistryOptions; log: (message: string) => void }) {
    if (options.directory) this.local = new BlobStore(options.directory);
    if (options.repository) this.remote = new Publisher(options.repository, options.registry);
  }
  private validate(input: unknown, key: Digest, kind: "deps" | "assets", expected?: { destination: string; platform: Platform | null }): CacheRecord {
    const value = object(input, "Cache config");
    const layer = object(value.layer, "Cache layer");
    if (value.schemaVersion !== 1 || value.key !== key || value.kind !== kind || value.packFormat !== packFormat || layer.kind !== kind
      || !Array.isArray(value.inventory) || !Array.isArray(value.native) || typeof value.destination !== "string") throw new Error("Unsupported or inconsistent cache metadata");
    if (expected && (value.destination !== expected.destination || Buffer.compare(Buffer.from(canonicalJSON(value.platform)), Buffer.from(canonicalJSON(expected.platform))))) throw new Error("Cache destination/platform mismatch");
    assertDigest(layer.diffId as string);
    const d = descriptor(layer.descriptor);
    if (d.mediaType !== media.gzip) throw new Error("Unsupported cache layer compression");
    for (const item of value.inventory) {
      const pkg = object(item, "Cache inventory");
      if (![pkg.path, pkg.name, pkg.version].every((v) => typeof v === "string")) throw new Error("Invalid cache inventory");
    }
    for (const item of value.native) {
      const binary = object(item, "Cache native inventory");
      if (typeof binary.path !== "string" || !["amd64", "arm64"].includes(String(binary.architecture)) || !Array.isArray(binary.needed) || !binary.needed.every((n) => typeof n === "string")) throw new Error("Invalid cache native inventory");
    }
    return value as unknown as CacheRecord;
  }

  async get(key: Digest, kind: "deps" | "assets", bypass = false, expected?: { destination: string; platform: Platform | null }): Promise<CacheRecord | undefined> {
    if (bypass) { this.events.push({ key, kind, status: "bypass" }); return; }
    const memory = this.records.get(key);
    if (memory) { this.events.push({ key, kind, status: "local" }); return memory; }
    if (this.local) {
      try {
        const record = this.validate(JSON.parse(await readFile(join(this.local!.root, "keys", kind, `${key.slice(7)}.json`), "utf8")), key, kind, expected);
        await this.store.copyFrom(this.local!, record.layer.descriptor);
        await decodeLayer(this.store, record.layer.descriptor, record.layer.diffId);
        this.records.set(key, record);
        this.events.push({ key, kind, status: "local" });
        return record;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.options.log(`Ignoring invalid local ${kind} cache\n`); }
    }
    if (this.remote) {
      try {
        const source = new RegistrySource(`${repositoryName(this.remote.ref)}:${cacheTag(kind, key)}`, this.options.registry);
        const root = await source.root();
        const manifest = object(JSON.parse(Buffer.from(root.bytes).toString()), "Cache manifest");
        if (root.descriptor.mediaType !== media.manifest || manifest.schemaVersion !== 2 || manifest.artifactType !== artifactMedia || !Array.isArray(manifest.layers) || manifest.layers.length !== 1) throw new Error("Invalid cache artifact");
        const config = descriptor(manifest.config), layer = descriptor(manifest.layers[0]);
        if (config.mediaType !== configMedia || config.size > 8 * 1024 * 1024) throw new Error("Invalid cache config descriptor");
        await this.store.putStream(await source.blob(config), config.mediaType, config);
        const record = this.validate(JSON.parse(Buffer.from(await this.store.read(config)).toString()), key, kind, expected);
        if (Buffer.compare(Buffer.from(canonicalJSON(record.layer.descriptor)), Buffer.from(canonicalJSON(layer)))) throw new Error("Cache layer descriptor mismatch");
        this.store.defer(layer, async () => {
          // Validate in a separate CAS before exposing the lazy stream, avoiding
          // recursive ensure() calls when checking the uncompressed digest.
          const staging = new BlobStore(join(this.store.root, "cache-import"));
          await staging.putStream(await source.blob(layer), layer.mediaType, layer);
          await decodeLayer(staging, layer, record.layer.diffId);
          return createReadStream(staging.path(layer.digest));
        }, source.ref);
        this.records.set(key, record);
        this.remoteHits.add(key);
        this.events.push({ key, kind, status: "registry" });
        return record;
      } catch (error) { if (!(error instanceof RegistryError && error.status === 404)) this.options.log(`Registry ${kind} cache unavailable; rebuilding\n`); }
    }
    this.events.push({ key, kind, status: "miss" });
  }

  async remember(record: CacheRecord): Promise<void> {
    this.records.set(record.key, record);
    if (!this.local) return;
    const dir = join(this.local.root, "keys", record.kind);
    const temporary = join(dir, `.tmp-${randomUUID()}`);
    try {
      await withCacheLock(this.local.root, async () => {
      await this.local!.copyFrom(this.store, record.layer.descriptor);
      await mkdir(dir, { recursive: true });
      await writeFile(temporary, canonicalJSON(record), { flag: "wx" });
      await rename(temporary, join(dir, `${record.key.slice(7)}.json`));
      });
    } catch { this.options.log(`Could not persist local ${record.kind} cache; check write permissions or .bunko-lock/owner.json for a stale lock\n`); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async publish(): Promise<void> {
    if (!this.remote) return;
    for (const record of this.records.values()) {
      if (this.remoteHits.has(record.key)) continue;
      try {
        const config = await this.store.put(canonicalJSON(record), configMedia);
        const manifest = await this.store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, artifactType: artifactMedia, config, layers: [record.layer.descriptor], annotations: { "org.bunko.cache.key": record.key, "org.bunko.cache.kind": record.kind } }), media.manifest);
        await this.remote.publish(this.store, manifest, [cacheTag(record.kind, record.key)]);
      } catch { this.options.log(`Could not publish ${record.kind} cache; image publication is unaffected\n`); }
    }
  }
}
