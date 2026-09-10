import { metric } from "./telemetry.ts";
import { validateLocations, type LocationDiagnostics } from "./location-diagnostics.ts";
import packageMetadata from "../../package.json";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
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
import { archivePath, type TarEntry } from "../oci/tar.ts";
import type { InventoryEntry, NativeBinary } from "./deps.ts";
import type { ClosurePackage } from "./closure.ts";
import type { UndeclaredImport } from "./undeclared-imports.ts";

const configMedia = "application/vnd.bunko.cache.config.v1+json";
const artifactMedia = "application/vnd.bunko.cache.v1";
export const packFormat = `tar-gzip-v4/bunko-${packageMetadata.version}/bun-${Bun.version}-${Bun.revision}`;
export class CacheConflictError extends Error {}
export const cacheMetadataLimit = 8 * 1024 ** 2;
async function readMetadata(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (file.size > cacheMetadataLimit) throw new Error("Cache metadata exceeds size limit");
  const bytes = await file.bytes();
  if (bytes.length > cacheMetadataLimit) throw new Error("Cache metadata exceeds size limit");
  return JSON.parse(Buffer.from(bytes).toString());
}
const maxLayerBytes = 2 * 1024 ** 3;
/** Bumping this invalidates every stored closure plan without touching content-addressed layer identity. */
export const closurePlanLayout = "closure-plan-v2";
const maxPlanAliases = 100_000, maxPlanFindings = 100_000;

export interface CacheRecord {
  schemaVersion: 1; key: Digest; kind: "deps" | "assets" | "app" | "runtime"; packFormat: string;
  destination: string; platform: Platform | null; layer: Layer;
  inventory: InventoryEntry[]; native: NativeBinary[];
  application?: { locations: LocationDiagnostics; entry: string; entrypoints?: Record<string, string>; entries: { path: string; type: "file" | "directory" }[] };
}
/**
 * Maps a pre-install closure plan key to the content-addressed closure key a full
 * build produced, plus the target aliases and diagnostics that projection would
 * otherwise have to recompute. The plan is an index into the layer cache, never a
 * layer identity: a hit is only honoured once the referenced `deps` record itself
 * validates and materializes.
 */
export interface ClosurePlanRecord {
  schemaVersion: 1; kind: "deps-plan"; layout: string; packFormat: string; planKey: Digest; key: Digest;
  destination: string; platform: Platform; aliases: Record<string, TarEntry[]>; undeclared: UndeclaredImport[]; optionalUndeclared: UndeclaredImport[]; omitted: number;
  packages: ClosurePackage[];
}
export function validateClosurePlan(input: unknown, planKey: Digest, expected: { destination: string; platform: Platform }): ClosurePlanRecord {
  const value = object(input, "Closure plan");
  if (value.schemaVersion !== 1 || value.kind !== "deps-plan" || value.layout !== closurePlanLayout || value.packFormat !== packFormat || value.planKey !== planKey || value.destination !== expected.destination
    || Buffer.compare(Buffer.from(canonicalJSON(value.platform)), Buffer.from(canonicalJSON(expected.platform)))
    || !Number.isSafeInteger(value.omitted) || (value.omitted as number) < 0 || !Array.isArray(value.undeclared) || value.undeclared.length > maxPlanFindings) throw new Error("Unsupported or inconsistent closure plan metadata");
  assertDigest(value.key as string);
  // Aliases become real symlinks in the application layer, so validate their shape and paths before they are reused.
  for (const list of Object.values(object(value.aliases, "Closure plan aliases"))) {
    if (!Array.isArray(list) || list.length > maxPlanAliases) throw new Error("Invalid closure plan aliases");
    for (const raw of list) {
      const entry = object(raw, "Closure plan alias");
      if (entry.type !== "symlink" || typeof entry.path !== "string" || typeof entry.target !== "string" || !entry.target.length) throw new Error("Invalid closure plan alias");
      archivePath(entry.path);
    }
  }
  if (!Array.isArray(value.optionalUndeclared) || value.optionalUndeclared.length > maxPlanFindings) throw new Error("Invalid closure plan optional findings");
  for (const [findings, code] of [[value.undeclared, "BUNKO_UNDECLARED_IMPORT"], [value.optionalUndeclared, "BUNKO_OPTIONAL_IMPORT"]] as const) for (const raw of findings) {
    const item = object(raw, "Closure plan finding");
    if (item.code !== code || !["package", "version", "path", "name", "file"].every((field) => typeof item[field] === "string")) throw new Error("Invalid closure plan finding");
  }
  if (!Array.isArray(value.packages) || value.packages.length > maxPlanAliases) throw new Error("Invalid closure plan packages");
  for (const raw of value.packages) {
    const pkg = object(raw, "Closure plan package");
    if (!["name", "version", "path"].every((field) => typeof pkg[field] === "string")
      || !["bytes", "files"].every((field) => Number.isSafeInteger(pkg[field]) && (pkg[field] as number) >= 0)
      || !Array.isArray(pkg.via) || !pkg.via.length || !pkg.via.every((name) => typeof name === "string")) throw new Error("Invalid closure plan package");
    archivePath(pkg.path as string);
  }
  return value as unknown as ClosurePlanRecord;
}

export interface CacheEvent { kind: "deps" | "assets" | "app" | "runtime"; key: Digest; status: "local" | "registry" | "miss" | "bypass"; source?: string; reason?: "disabled" | "not-found" | "invalid-or-unavailable" }
export function cacheKey(inputs: unknown): Digest { return sha256(Buffer.concat([Buffer.from("bunko/cache/v1\0"), Buffer.from(canonicalJSON(inputs))])); }
export function cacheTag(kind: string, key: Digest) { assertDigest(key); return `bunko-cache-v1-${kind}-${key.slice(7)}`; }

export async function assetInputs(entries: TarEntry[]): Promise<unknown> {
  return mapFiles(entries, async (entry) => entry.type === "file" ? {
    type: entry.type, path: entry.path, executable: Boolean(entry.executable), ...(entry.mode !== undefined ? { mode: entry.mode } : {}), digest: "source" in entry ? await hashFile(entry.source) : sha256(entry.content),
  } : entry);
}

export class LayerCache {
  readonly events: CacheEvent[] = [];
  private event(event: CacheEvent) {
    this.events.push(event);
    metric("bunko.cache.lookup.count", "{lookup}", 1, { "bunko.cache.kind": event.kind, "bunko.cache.result": event.status });
  }
  private readonly invalidLocal = new Set<Digest>();
  private readonly origins = new Map<Digest, string>();
  private readonly fetched = new Set<Digest>();
  private readonly remoteHits = new Set<Digest>();
  private readonly persistence: { disabled?: boolean };
  private readonly records = new Map<Digest, CacheRecord>();
  private readonly local?: BlobStore;
  private readonly remote?: Publisher;
  private readonly readers: Publisher[];
  constructor(readonly store: BlobStore, private readonly options: { directory?: string; repository?: string; readRepositories?: string[]; registry?: RegistryOptions; persistence?: { disabled?: boolean }; log: (message: string) => void }) {
    this.persistence = options.persistence ?? {};
    if (options.directory) this.local = new BlobStore(options.directory);
    if (options.repository) this.remote = new Publisher(options.repository, options.registry);
    this.readers = [...new Set([...(options.readRepositories ?? []), ...options.repository ? [options.repository] : []].map((value) => repositoryName(new Publisher(value, options.registry).ref)))].map((value) => new Publisher(value, options.registry));
  }
  private validate(input: unknown, key: Digest, kind: "deps" | "assets" | "app" | "runtime", expected?: { destination: string; platform: Platform | null; application?: { entry: string; entrypoints: Record<string, string> } }): CacheRecord {
    const value = object(input, "Cache config");
    const layer = object(value.layer, "Cache layer");
    if (value.schemaVersion !== 1 || value.key !== key || value.kind !== kind || value.packFormat !== packFormat || layer.kind !== kind
      || !Array.isArray(value.inventory) || !Array.isArray(value.native) || typeof value.destination !== "string") throw new Error("Unsupported or inconsistent cache metadata");
    if (expected && (value.destination !== expected.destination || Buffer.compare(Buffer.from(canonicalJSON(value.platform)), Buffer.from(canonicalJSON(expected.platform))))) throw new Error("Cache destination/platform mismatch");
    assertDigest(layer.diffId as string);
    const d = descriptor(layer.descriptor);
    if (d.mediaType !== media.gzip || d.size > maxLayerBytes) throw new Error("Unsupported cache layer compression");
    for (const item of value.inventory) {
      const pkg = object(item, "Cache inventory");
      if (![pkg.path, pkg.name, pkg.version].every((v) => typeof v === "string")) throw new Error("Invalid cache inventory");
    }
    for (const item of value.native) {
      const binary = object(item, "Cache native inventory");
      if (typeof binary.path !== "string" || !["amd64", "arm64"].includes(String(binary.architecture)) || !Array.isArray(binary.needed) || !binary.needed.every((n) => typeof n === "string")) throw new Error("Invalid cache native inventory");
    }
    if (kind === "app") {
      const app = object(value.application, "Application cache"), destination = value.destination;
      if (typeof app.entry !== "string" || !Array.isArray(app.entries) || app.entries.length > 200_000) throw new Error("Invalid application cache metadata");
      if (expected?.application && (app.entry !== expected.application.entry || !Buffer.from(canonicalJSON(app.entrypoints ?? null)).equals(Buffer.from(canonicalJSON(expected.application.entrypoints))))) throw new Error("Cached named entrypoints do not match project configuration");
      validateLocations(app.locations);
      archivePath(app.entry);
      for (const raw of app.entries) {
        const entry = object(raw, "Cached output");
        if (typeof entry.path !== "string" || !["file", "directory"].includes(String(entry.type)) || !entry.path.startsWith(`${destination.slice(1)}/`)) throw new Error("Invalid cached output path/type");
        archivePath(entry.path);
      }
      if (app.entrypoints !== undefined) {
        for (const [name, path] of Object.entries(object(app.entrypoints, "Cached named entrypoints"))) {
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) || typeof path !== "string") throw new Error("Invalid cached named entrypoint");
          archivePath(path);
          if (!app.entries.some((raw) => { const entry = object(raw, "Cached entry"); return entry.type === "file" && entry.path === `${destination.slice(1)}/${path}`; })) throw new Error("Cached named entrypoint is missing");
        }
      }
      if (!app.entries.some((raw) => { const entry = object(raw, "Cached entry"); return entry.type === "file" && entry.path === `${destination.slice(1)}/${app.entry}`; })) throw new Error("Cached application entrypoint is missing");
    }
    return value as unknown as CacheRecord;
  }

  async get(key: Digest, kind: "deps" | "assets" | "app" | "runtime", bypass = false, expected?: { destination: string; platform: Platform | null; application?: { entry: string; entrypoints: Record<string, string> } }): Promise<CacheRecord | undefined> {
    if (bypass) { this.event({ key, kind, status: "bypass", reason: "disabled" }); return; }
    const memory = this.records.get(key);
    if (memory) { const source = this.origins.get(key); this.event({ key, kind, status: source ? "registry" : "local", ...(source ? { source } : {}) }); return memory; }
    if (this.local) {
      let found = false;
      try {
        const value = await readMetadata(join(this.local!.root, "keys", kind, `${key.slice(7)}.json`)); found = true;
        const record = this.validate(value, key, kind, expected);
        await this.store.copyFrom(this.local!, record.layer.descriptor);
        await decodeLayer(this.store, record.layer.descriptor, record.layer.diffId, undefined, maxLayerBytes);
        this.records.set(key, record);
        this.event({ key, kind, status: "local" });
        return record;
      } catch (error) { if (found || (error as NodeJS.ErrnoException).code !== "ENOENT") { this.invalidLocal.add(key); this.options.log(`Ignoring invalid local ${kind} cache\n`); } }
    }
    let unavailable = false;
    for (const reader of this.readers) {
      let found = false;
      try {
        const source = new RegistrySource(`${repositoryName(reader.ref)}:${cacheTag(kind, key)}`, this.options.registry);
        const root = await source.root(); found = true;
        const manifest = object(JSON.parse(Buffer.from(root.bytes).toString()), "Cache manifest");
        if (root.descriptor.mediaType !== media.manifest || manifest.schemaVersion !== 2 || manifest.artifactType !== artifactMedia || !Array.isArray(manifest.layers) || manifest.layers.length !== 1) throw new Error("Invalid cache artifact");
        const config = descriptor(manifest.config), layer = descriptor(manifest.layers[0]);
        if (config.mediaType !== configMedia || config.size > cacheMetadataLimit) throw new Error("Invalid cache config descriptor");
        await this.store.putStream(await source.blob(config), config.mediaType, config);
        const record = this.validate(JSON.parse(Buffer.from(await this.store.read(config)).toString()), key, kind, expected);
        if (Buffer.compare(Buffer.from(canonicalJSON(record.layer.descriptor)), Buffer.from(canonicalJSON(layer)))) throw new Error("Cache layer descriptor mismatch");
        // Materialize before accepting the hit so corruption becomes a miss
        // while all targets are still in the preparation phase.
        await this.store.putStream(await source.blob(layer), layer.mediaType, layer);
        await decodeLayer(this.store, layer, record.layer.diffId, undefined, maxLayerBytes);
        this.store.origins.set(layer.digest, source.ref);
        this.records.set(key, record); this.origins.set(key, repositoryName(reader.ref)); this.fetched.add(key);
        if (this.remote && repositoryName(reader.ref) === repositoryName(this.remote.ref)) this.remoteHits.add(key);
        this.event({ key, kind, status: "registry", source: repositoryName(reader.ref) });
        return record;
      } catch (error) { if (found || !(error instanceof RegistryError && error.status === 404)) { unavailable = true; this.options.log(`Registry ${kind} cache unavailable; trying remaining sources\n`); } }
    }
    this.event({ key, kind, status: "miss", reason: unavailable || this.invalidLocal.has(key) ? "invalid-or-unavailable" : "not-found" });
  }

  /** Reads the closure plan index. A missing, stale or malformed entry is a miss: the caller reprojects. */
  async plan(planKey: Digest, expected: { destination: string; platform: Platform }): Promise<ClosurePlanRecord | undefined> {
    if (!this.local) return;
    let found = false;
    try {
      const value = await readMetadata(join(this.local.root, "plans", "deps", `${planKey.slice(7)}.json`)); found = true;
      return validateClosurePlan(value, planKey, expected);
    } catch (error) { if (found || (error as NodeJS.ErrnoException).code !== "ENOENT") this.options.log("Ignoring invalid local dependency closure plan\n"); }
  }

  /** Replaces any earlier plan for the same key: the newest full build describes the current inputs. */
  async rememberPlan(record: ClosurePlanRecord): Promise<void> {
    const bytes = canonicalJSON(record);
    if (!this.local || this.persistence.disabled || bytes.length > cacheMetadataLimit) return;
    const dir = join(this.local.root, "plans", "deps");
    const temporary = join(dir, `.tmp-${randomUUID()}`);
    try {
      await withCacheLock(this.local.root, async () => {
        // A plan must never outlive the record it names, so reconfirm that record under this
        // lock: a prune between persisting the layer and indexing it leaves no orphan behind.
        try { this.validate(await readMetadata(join(this.local!.root, "keys", "deps", `${record.key.slice(7)}.json`)), record.key, "deps", { destination: record.destination, platform: record.platform }); }
        catch { return; }
        await mkdir(dir, { recursive: true });
        await writeFile(temporary, bytes, { flag: "wx" });
        await rename(temporary, join(dir, `${record.planKey.slice(7)}.json`));
      }, () => !this.persistence.disabled);
    } catch { this.options.log("Could not persist the local dependency closure plan; the next build reprojects the closure\n"); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async persistHits(): Promise<void> {
    for (const key of this.fetched) await this.remember(this.records.get(key)!);
    this.fetched.clear();
  }

  async remember(record: CacheRecord): Promise<void> {
    const bytes = canonicalJSON(record);
    if (bytes.length > cacheMetadataLimit) { this.options.log("Cache metadata exceeds size limit; skipping cache persistence and publication\n"); return; }
    this.records.set(record.key, record);
    if (!this.local || this.persistence.disabled) return;
    const dir = join(this.local.root, "keys", record.kind);
    const temporary = join(dir, `.tmp-${randomUUID()}`);
    try {
      await withCacheLock(this.local.root, async () => {
      if (!this.invalidLocal.has(record.key)) {
        let previous: CacheRecord | undefined;
        try { previous = this.validate(await readMetadata(join(dir, `${record.key.slice(7)}.json`)), record.key, record.kind, { destination: record.destination, platform: record.platform }); }
        catch { /* Missing or malformed entries are replaced by verified outputs. */ }
        if (previous && previous.layer.descriptor.digest !== record.layer.descriptor.digest) {
          let valid = false;
          try { valid = await hashFile(this.local!.path(previous.layer.descriptor.digest)) === previous.layer.descriptor.digest; } catch { /* Incomplete cache is a miss. */ }
          if (valid) throw new CacheConflictError("Different output for the same cache key; refusing to overwrite a concurrent or nondeterministic build");
        }
      }
      await this.local!.copyFrom(this.store, record.layer.descriptor);
      await mkdir(dir, { recursive: true });
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, join(dir, `${record.key.slice(7)}.json`));
      }, () => !this.persistence.disabled);
    } catch (error) { if (error instanceof CacheConflictError) throw error; this.persistence.disabled = true; this.options.log(`Could not persist local ${record.kind} cache; another writer may be busy, or check write permissions and .bunko-lock/owner.json\n`); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async publish(): Promise<void> {
    if (!this.remote) return;
    for (const record of this.records.values()) {
      if (this.remoteHits.has(record.key)) continue;
      try {
        try {
          const source = new RegistrySource(`${repositoryName(this.remote.ref)}:${cacheTag(record.kind, record.key)}`, this.options.registry);
          const existing = object(JSON.parse(Buffer.from((await source.root()).bytes).toString()), "Existing cache manifest");
          if (existing.artifactType !== artifactMedia) throw new Error("Cache tag is occupied by an unrelated artifact");
          const config = descriptor(existing.config);
          if (config.mediaType !== configMedia || config.size > cacheMetadataLimit) throw new Error("Invalid existing cache config");
          await this.store.putStream(await source.blob(config), config.mediaType, config);
          const previous = this.validate(JSON.parse(Buffer.from(await this.store.read(config)).toString()), record.key, record.kind, { destination: record.destination, platform: record.platform });
          if (Buffer.compare(Buffer.from(canonicalJSON(previous.layer)), Buffer.from(canonicalJSON(record.layer)))) throw new CacheConflictError("Different output for the same Registry cache key; refusing to overwrite it");
          continue;
        } catch (error) { if (!(error instanceof RegistryError && error.status === 404)) throw error; }
        const config = await this.store.put(canonicalJSON(record), configMedia);
        const manifest = await this.store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, artifactType: artifactMedia, config, layers: [record.layer.descriptor], annotations: { "org.bunko.cache.key": record.key, "org.bunko.cache.kind": record.kind } }), media.manifest);
        await this.remote.publish(this.store, manifest, [cacheTag(record.kind, record.key)]);
      } catch (error) { this.options.log(`Could not publish ${record.kind} cache; image publication is unaffected\n`); }
    }
  }
}
