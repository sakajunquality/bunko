import { cacheBackend, type CacheBackend } from "./cache-backends.ts";
import type { CacheLocation } from "./cache-backend-options.ts";
import { metric } from "./telemetry.ts";
import { validateLocations, type LocationDiagnostics } from "./location-diagnostics.ts";
import packageMetadata from "../../package.json";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BlobStore } from "../oci/blob-store.ts";
import { decodeLayer } from "../oci/decode.ts";
import { assertDigest, canonicalJSON, descriptor, object, sha256 } from "../oci/digest.ts";
import { publishConcurrency, Publisher, PublicationError, repositoryName } from "../oci/publish.ts";
import { RegistryError, RegistryConnectionError, type RegistryOptions } from "../oci/registry.ts";
import { RegistrySource } from "../oci/source.ts";
import { media, type Digest, type Layer, type Platform } from "../oci/types.ts";
import { hashFile } from "./files.ts";
import { withCacheLock } from "./cache-lock.ts";
import { mapFiles } from "./concurrency.ts";
import { boundedMap } from "../oci/concurrency.ts";
import { archivePath, assertArchiveEntries, type TarEntry } from "../oci/tar.ts";
import type { InventoryEntry, NativeBinary } from "./deps.ts";
import type { ClosurePackage } from "./closure.ts";
import type { UndeclaredImport } from "./undeclared-imports.ts";

const configMedia = "application/vnd.bunko.cache.config.v1+json";
/** Plan artifacts carry their record in the config blob, under their own type so a layer record can never be read as one. */
const planConfigMedia = "application/vnd.bunko.cache.plan.config.v1+json";
/** A plan indexes a layer instead of owning one, and OCI asks an artifact for a layer list anyway. */
const emptyLayerMedia = "application/vnd.oci.empty.v1+json";
const artifactMedia = "application/vnd.bunko.cache.v1";
export const packFormat = `tar-gzip-v4/bunko-${packageMetadata.version}/bun-${Bun.version}-${Bun.revision}`;
export class CacheConflictError extends Error {}
class InvalidRemoteCacheError extends Error {}
export type CacheKind = CacheRecord["kind"] | ClosurePlanRecord["kind"];
export interface CacheExportEvent {
  backend: "registry" | "local"; destination: string; kind: CacheKind; key: Digest;
  status: "written" | "already-present" | "failed";
  reason?: "conflict" | "invalid" | "denied" | "timeout" | "unavailable";
  bytes: number; durationMs: number; reconciled?: boolean;
}
export class CacheExportError extends Error {
  constructor(cause?: unknown) { super("Cache export failed; inspect cacheExports in the build report (an image may already be published)", { cause }); }
}
function exportFailure(error: unknown): NonNullable<CacheExportEvent["reason"]> {
  if (error instanceof CacheConflictError) return "conflict";
  const invalid = error instanceof InvalidRemoteCacheError;
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error) && seen.size < 8) {
    seen.add(error);
    if (error instanceof RegistryConnectionError) return "unavailable";
    if (error instanceof RegistryError) {
      if (error.status === 404) return "invalid";
      if ([401, 403].includes(error.status)) return "denied";
      if ([408, 504].includes(error.status)) return "timeout";
    }
    if (error.name === "TimeoutError" || /timeout|timed out/i.test(error.message)) return "timeout";
    if ("code" in error && /^(ECONN|ENET|EHOST|EPIPE|ETIMEDOUT)/.test(String(error.code))) return error.code === "ETIMEDOUT" ? "timeout" : "unavailable";
    error = error.cause;
  }
  return invalid ? "invalid" : "unavailable";
}
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
  // Aliases become real symlinks in the application layer, so they are held to the packing rules
  // here rather than at pack time: a stored plan that could not be packed must be a miss while the
  // build can still reproject, never an exception raised after the closure has been accepted.
  const aliases: Record<string, TarEntry[]> = Object.create(null);
  for (const [target, list] of Object.entries(object(value.aliases, "Closure plan aliases"))) {
    if (!Array.isArray(list) || list.length > maxPlanAliases) throw new Error("Invalid closure plan aliases");
    aliases[target] = list.map((raw) => {
      const entry = object(raw, "Closure plan alias");
      if (entry.type !== "symlink" || typeof entry.path !== "string" || typeof entry.target !== "string" || !entry.target.length) throw new Error("Invalid closure plan alias");
      return { type: "symlink" as const, path: archivePath(entry.path), target: entry.target };
    });
    assertArchiveEntries(aliases[target]!);
  }
  if (!Array.isArray(value.optionalUndeclared) || value.optionalUndeclared.length > maxPlanFindings) throw new Error("Invalid closure plan optional findings");
  const [undeclared, optionalUndeclared] = ([[value.undeclared, "BUNKO_UNDECLARED_IMPORT"], [value.optionalUndeclared, "BUNKO_OPTIONAL_IMPORT"]] as const).map(([findings, code]) => findings.map((raw): UndeclaredImport => {
    const item = object(raw, "Closure plan finding");
    if (item.code !== code || !["package", "version", "path", "name", "file"].every((field) => typeof item[field] === "string")) throw new Error("Invalid closure plan finding");
    return { code, package: item.package as string, version: item.version as string, path: item.path as string, name: item.name as string, file: item.file as string };
  }));
  if (!Array.isArray(value.packages) || value.packages.length > maxPlanAliases) throw new Error("Invalid closure plan packages");
  const packages = value.packages.map((raw): ClosurePackage => {
    const pkg = object(raw, "Closure plan package");
    if (!["name", "version", "path"].every((field) => typeof pkg[field] === "string")
      || !["bytes", "files"].every((field) => Number.isSafeInteger(pkg[field]) && (pkg[field] as number) >= 0)
      || !Array.isArray(pkg.via) || !pkg.via.length || !pkg.via.every((name) => typeof name === "string")) throw new Error("Invalid closure plan package");
    return { name: pkg.name as string, version: pkg.version as string, path: archivePath(pkg.path as string), bytes: pkg.bytes as number, files: pkg.files as number, via: [...pkg.via as string[]] };
  });
  // Rebuild the record from the fields that were checked instead of returning the parsed object.
  // An unvalidated extra field would otherwise be replayed and re-serialised, and one that is
  // merely large or deeply nested — both cheap to write and within the metadata size limit —
  // would fail canonicalJSON well after the plan had been accepted, taking the build with it.
  return { schemaVersion: 1, kind: "deps-plan", layout: closurePlanLayout, packFormat, planKey, key: value.key as Digest,
    destination: expected.destination, platform: expected.platform, aliases, undeclared: undeclared!, optionalUndeclared: optionalUndeclared!,
    omitted: value.omitted as number, packages };
}

export interface CacheEvent { kind: CacheKind; key: Digest; status: "local" | "registry" | "miss" | "bypass"; source?: string; reason?: "disabled" | "not-found" | "invalid-or-unavailable" }
export function cacheKey(inputs: unknown): Digest { return sha256(Buffer.concat([Buffer.from("bunko/cache/v1\0"), Buffer.from(canonicalJSON(inputs))])); }
export function cacheTag(kind: string, key: Digest) { assertDigest(key); return `bunko-cache-v1-${kind}-${key.slice(7)}`; }

export async function assetInputs(entries: TarEntry[]): Promise<unknown> {
  return mapFiles(entries, async (entry) => entry.type === "file" ? {
    type: entry.type, path: entry.path, executable: Boolean(entry.executable), ...(entry.mode !== undefined ? { mode: entry.mode } : {}), digest: "source" in entry ? await hashFile(entry.source) : sha256(entry.content),
  } : entry);
}

export class CacheDriver {
  readonly events: CacheEvent[] = [];
  readonly exports: CacheExportEvent[] = [];
  private event(event: CacheEvent) {
    this.events.push(event);
    if (this.options.lookupMetrics !== false) metric("bunko.cache.lookup.count", "{lookup}", 1, { "bunko.cache.kind": event.kind, "bunko.cache.result": event.status });
  }
  private readonly invalidLocal = new Set<Digest>();
  private readonly invalidPlans = new Set<Digest>();
  private readonly origins = new Map<Digest, string>();
  private readonly fetched = new Set<Digest>();
  private readonly remoteHits = new Set<Digest>();
  private readonly persistence: { disabled?: boolean };
  private readonly records = new Map<Digest, CacheRecord>();
  private readonly local?: BlobStore;
  private readonly remote?: Publisher;
  private readonly readers: Publisher[];
  constructor(readonly store: BlobStore, private readonly options: { directory?: string; repository?: string; readRepositories?: string[]; exportError?: "warn" | "fail"; strictLocal?: boolean; lookupMetrics?: boolean; registry?: RegistryOptions; persistence?: { disabled?: boolean }; log: (message: string) => void }) {
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
    } catch (error) { if (found || (error as NodeJS.ErrnoException).code !== "ENOENT") { this.invalidPlans.add(planKey); this.options.log("Ignoring invalid local dependency closure plan\n"); } }
  }
  /** Distinguishes a plan that was absent from one that was present but unusable, for the lookup reason. */
  planUnavailable(planKey: Digest): boolean { return this.invalidPlans.has(planKey); }

  /**
   * Reads the same plan record from the ordered registry cache sources. Everything the registry
   * supplies passes `validateClosurePlan` against the expected key, destination and platform, so a
   * truncated, tampered or foreign artifact is a miss with a reason and never a build failure.
   */
  async remotePlan(planKey: Digest, expected: { destination: string; platform: Platform }): Promise<{ record?: ClosurePlanRecord; source?: string; unavailable: boolean }> {
    let unavailable = false;
    for (const reader of this.readers) {
      let found = false;
      try {
        const source = new RegistrySource(`${repositoryName(reader.ref)}:${cacheTag("deps-plan", planKey)}`, this.options.registry);
        const root = await source.root(); found = true;
        const config = this.planDescriptor(root);
        await this.store.putStream(await source.blob(config), config.mediaType, config);
        const record = validateClosurePlan(JSON.parse(Buffer.from(await this.store.read(config)).toString()), planKey, expected);
        return { record, source: repositoryName(reader.ref), unavailable: false };
      } catch (error) { if (found || !(error instanceof RegistryError && error.status === 404)) { unavailable = true; this.options.log("Registry dependency closure plan unavailable or invalid; trying remaining sources\n"); } }
    }
    return { unavailable };
  }

  /** The one shape a plan artifact may have; anything else is rejected before a blob is fetched. */
  private planDescriptor(root: Awaited<ReturnType<RegistrySource["root"]>>) {
    const manifest = object(JSON.parse(Buffer.from(root.bytes).toString()), "Cache manifest");
    const annotations = object(manifest.annotations ?? {}, "Cache annotations");
    if (root.descriptor.mediaType !== media.manifest || manifest.schemaVersion !== 2 || manifest.artifactType !== artifactMedia
      || annotations["org.bunko.cache.kind"] !== "deps-plan" || !Array.isArray(manifest.layers) || manifest.layers.length !== 1) throw new Error("Invalid closure plan artifact");
    const config = descriptor(manifest.config);
    if (config.mediaType !== planConfigMedia || config.size > cacheMetadataLimit) throw new Error("Invalid closure plan config descriptor");
    return config;
  }

  private async existingPlan(record: ClosurePlanRecord): Promise<boolean> {
    const source = new RegistrySource(`${repositoryName(this.remote!.ref)}:${cacheTag(record.kind, record.planKey)}`, this.options.registry);
    let root: Awaited<ReturnType<RegistrySource["root"]>>;
    try { root = await source.root(); }
    catch (error) { if (error instanceof RegistryError && error.status === 404) return false; throw error; }
    try {
      const config = this.planDescriptor(root);
      await this.store.putStream(await source.blob(config), config.mediaType, config);
      const previous = validateClosurePlan(JSON.parse(Buffer.from(await this.store.read(config)).toString()), record.planKey, { destination: record.destination, platform: record.platform });
      if (!Buffer.from(canonicalJSON(previous)).equals(Buffer.from(canonicalJSON(record)))) throw new CacheConflictError("Different closure plan for the same Registry plan key; refusing to overwrite it");
      return true;
    } catch (error) {
      if (error instanceof CacheConflictError || error instanceof RegistryError) throw error;
      throw new InvalidRemoteCacheError("Invalid existing closure plan record", { cause: error });
    }
  }

  /** Publishes one plan artifact. Like `exportRecord` it never throws, so a plan can never fail a build under `warn`. */
  async publishPlan(record: ClosurePlanRecord): Promise<{ event: CacheExportEvent; error?: unknown }> {
    const started = performance.now();
    const event: CacheExportEvent = { backend: "registry", destination: repositoryName(this.remote!.ref), kind: record.kind, key: record.planKey, status: "already-present", bytes: 0, durationMs: 0 };
    let failure: unknown;
    try {
      const bytes = canonicalJSON(record);
      if (bytes.length > cacheMetadataLimit) throw new InvalidRemoteCacheError("Closure plan exceeds the cache metadata size limit");
      if (!await this.existingPlan(record)) {
        const config = await this.store.put(bytes, planConfigMedia);
        const empty = await this.store.put(Buffer.from("{}"), emptyLayerMedia);
        const manifest = await this.store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, artifactType: artifactMedia, config, layers: [empty],
          annotations: { "org.bunko.cache.key": record.planKey, "org.bunko.cache.kind": record.kind, "org.bunko.cache.plan.layout": record.layout, "org.bunko.cache.pack.format": record.packFormat } }), media.manifest);
        try {
          const result = await this.remote!.publish(this.store, manifest, [cacheTag(record.kind, record.planKey)], undefined, false, "fail", 1);
          event.bytes = result.transfers.reduce((sum, item) => sum + item.uploaded, 0);
          event.status = "written";
        } catch (error) {
          if (error instanceof PublicationError) event.bytes = error.result.transfers.reduce((sum, item) => sum + item.uploaded, 0);
          let present = false;
          try { present = await this.existingPlan(record); }
          catch (check) { if (check instanceof CacheConflictError || check instanceof InvalidRemoteCacheError) throw check; }
          if (!present) throw error;
          event.reconciled = true;
        }
      }
    } catch (error) {
      failure = error;
      event.status = "failed"; event.reason = exportFailure(error);
      this.options.log(`Could not publish ${record.kind} cache (${event.reason}); image publication is unaffected\n`);
    }
    event.durationMs = performance.now() - started;
    return { event, error: failure };
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
        if (previous && (this.options.strictLocal ? !Buffer.from(canonicalJSON(previous)).equals(Buffer.from(canonicalJSON(record))) : previous.layer.descriptor.digest !== record.layer.descriptor.digest)) {
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
    } catch (error) { if (error instanceof CacheConflictError || this.options.strictLocal) throw error; this.persistence.disabled = true; this.options.log(`Could not persist local ${record.kind} cache; another writer may be busy, or check write permissions and .bunko-lock/owner.json\n`); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  private async existing(record: CacheRecord): Promise<boolean> {
    const source = new RegistrySource(`${repositoryName(this.remote!.ref)}:${cacheTag(record.kind, record.key)}`, this.options.registry);
    let root: Awaited<ReturnType<RegistrySource["root"]>>;
    try { root = await source.root(); }
    catch (error) { if (error instanceof RegistryError && error.status === 404) return false; throw error; }
    try {
      const manifest = object(JSON.parse(Buffer.from(root.bytes).toString()), "Existing cache manifest");
      if (root.descriptor.mediaType !== media.manifest || manifest.schemaVersion !== 2 || manifest.artifactType !== artifactMedia || !Array.isArray(manifest.layers) || manifest.layers.length !== 1) throw new Error("Invalid existing cache artifact");
      const config = descriptor(manifest.config), layer = descriptor(manifest.layers[0]);
      if (config.mediaType !== configMedia || config.size > cacheMetadataLimit) throw new Error("Invalid existing cache config");
      await this.store.putStream(await source.blob(config), config.mediaType, config);
      const previous = this.validate(JSON.parse(Buffer.from(await this.store.read(config)).toString()), record.key, record.kind, { destination: record.destination, platform: record.platform });
      if (!Buffer.from(canonicalJSON(previous.layer.descriptor)).equals(Buffer.from(canonicalJSON(layer)))) throw new Error("Existing cache layer descriptor mismatch");
      // Verify the winning record's payload before accepting an idempotent write.
      await this.store.putStream(await source.blob(layer), layer.mediaType, layer);
      await decodeLayer(this.store, layer, previous.layer.diffId, undefined, maxLayerBytes);
      if (!Buffer.from(canonicalJSON(previous)).equals(Buffer.from(canonicalJSON(record)))) throw new CacheConflictError("Different output or metadata for the same Registry cache key; refusing to overwrite it");
      return true;
    } catch (error) {
      if (error instanceof CacheConflictError || error instanceof RegistryError) throw error;
      throw new InvalidRemoteCacheError("Invalid existing cache record", { cause: error });
    }
  }

  /** One cache artifact: an existence check, then the artifact itself. Never throws, so a
   * parallel batch reports every record instead of stopping at the first refusal. */
  private async exportRecord(record: CacheRecord): Promise<{ event: CacheExportEvent; error?: unknown }> {
    const started = performance.now();
    const event: CacheExportEvent = { backend: "registry", destination: repositoryName(this.remote!.ref), kind: record.kind, key: record.key, status: "already-present", bytes: 0, durationMs: 0 };
    let failure: unknown;
    try {
      if (!this.remoteHits.has(record.key) && !await this.existing(record)) {
        const config = await this.store.put(canonicalJSON(record), configMedia);
        const manifest = await this.store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, artifactType: artifactMedia, config, layers: [record.layer.descriptor], annotations: { "org.bunko.cache.key": record.key, "org.bunko.cache.kind": record.kind } }), media.manifest);
        try {
          // One blob at a time: the parallelism that matters here is across cache artifacts,
          // and nesting two bounds would multiply the in-flight requests.
          const result = await this.remote!.publish(this.store, manifest, [cacheTag(record.kind, record.key)], undefined, false, "fail", 1);
          event.bytes = result.transfers.reduce((sum, item) => sum + item.uploaded, 0);
          event.status = "written";
        } catch (error) {
          if (error instanceof PublicationError) event.bytes = error.result.transfers.reduce((sum, item) => sum + item.uploaded, 0);
          // A concurrent writer or a lost response can leave a valid winner.
          // Reconcile once, without treating a different key result as success.
          let present = false;
          try { present = await this.existing(record); }
          catch (check) { if (check instanceof CacheConflictError || check instanceof InvalidRemoteCacheError) throw check; }
          if (!present) throw error;
          event.reconciled = true;
        }
      }
    } catch (error) {
      failure = error;
      event.status = "failed"; event.reason = exportFailure(error);
      this.options.log(`Could not publish ${record.kind} cache (${event.reason}); image publication is unaffected\n`);
    }
    event.durationMs = performance.now() - started;
    return { event, error: failure };
  }

  async publish(): Promise<void> {
    if (!this.remote) return;
    // Cache artifacts are independent of one another, so their round trips overlap under the
    // same bound image publication uses. Events keep record order and the first failure by
    // that order still decides the outcome.
    const { results } = await boundedMap([...this.records.values()], this.remote.concurrency, (record) => this.exportRecord(record));
    let failed = false, firstFailure: unknown;
    for (const outcome of results) {
      if (!outcome) continue;
      const event = outcome.event;
      if (event.status === "failed") { if (!failed) firstFailure = outcome.error; failed = true; }
      this.exports.push(event);
      const labels = { "bunko.cache.backend": event.backend, "bunko.cache.kind": event.kind, "bunko.cache.result": event.status, "bunko.cache.reason": event.reason ?? "none" };
      metric("bunko.cache.export.count", "{export}", 1, labels);
      metric("bunko.cache.export.bytes", "By", event.bytes, labels);
      metric("bunko.cache.export.duration", "s", event.durationMs / 1000, labels, true);
    }
    if (failed && this.options.exportError === "fail") throw new CacheExportError(firstFailure);
  }
}


/** Coordinates ordered validated cache reads and independent export destinations. */
export class LayerCache {
  readonly events: CacheEvent[] = [];
  readonly exports: CacheExportEvent[] = [];
  private readonly local: CacheDriver;
  private readonly readers: CacheBackend[];
  private readonly writers: CacheBackend[];
  private readonly imported = new Set<Digest>();
  private readonly importedPlans = new Set<Digest>();
  private readonly records = new Map<Digest, CacheRecord>();
  private readonly planRecords = new Map<Digest, ClosurePlanRecord>();
  private readonly concurrency: number;
  constructor(readonly store: BlobStore, private readonly options: {
    directory?: string; repository?: string; readRepositories?: string[];
    sources?: CacheLocation[]; destinations?: CacheLocation[];
    exportError?: "warn" | "fail"; registry?: RegistryOptions;
    persistence?: { disabled?: boolean }; log: (message: string) => void;
  }) {
    this.local = new CacheDriver(store, { directory: options.directory, persistence: options.persistence, lookupMetrics: false, log: options.log });
    const unique = (locations: CacheLocation[]) => [...new Map(locations.map((location) => [JSON.stringify(location), location])).values()];
    const backends = new Map<string, CacheBackend>();
    const backendFor = (location: CacheLocation) => {
      const key = JSON.stringify(location);
      if (!backends.has(key)) backends.set(key, cacheBackend(location, store, options.registry, options.log));
      return backends.get(key)!;
    };
    this.readers = unique([...(options.sources ?? []), ...(options.readRepositories ?? []).map((repo): CacheLocation => ({ type: "registry", repo: repositoryName(new Publisher(repo).ref) })), ...(options.repository ? [{ type: "registry" as const, repo: repositoryName(new Publisher(options.repository).ref) }] : [])]).map(backendFor);
    const destinations = unique([...(options.destinations ?? []), ...(options.repository ? [{ type: "registry" as const, repo: repositoryName(new Publisher(options.repository).ref) }] : [])]);
    this.writers = destinations.map(backendFor);
    // The most restrictive registry destination sets the bound; local writers queue on the
    // directory lock regardless, so they never widen it.
    const hosts = destinations.filter((location) => location.type === "registry").map((location) => new Publisher(location.repo).ref.registry);
    this.concurrency = Math.min(...(hosts.length ? hosts : [""]).map((host) => publishConcurrency(host, options.registry?.publishConcurrency)));
  }
  async get(...args: Parameters<CacheDriver["get"]>): Promise<CacheRecord | undefined> {
    const [key, kind, bypass] = args;
    const before = this.local.events.length;
    let record = await this.local.get(...args);
    let event = this.local.events.at(-1)!;
    if (!record && !bypass) for (const backend of this.readers) {
      const hit = await backend.read(...args);
      if (hit.record) { this.imported.add(key); record = hit.record; event = { key, kind, status: backend.type, source: backend.destination }; break; }
      if (hit.unavailable) event = { key, kind, status: "miss", reason: "invalid-or-unavailable" };
    }
    if (record) this.records.set(key, record);
    if (this.local.events.length > before) {
      this.events.push(event);
      metric("bunko.cache.lookup.count", "{lookup}", 1, { "bunko.cache.kind": kind, "bunko.cache.result": event.status });
    }
    return record;
  }
  /**
   * Local first, then the ordered registry sources, so a runner whose local cache is empty still
   * reaches the warm path from the cache repository that already holds the closure layer. A
   * registry hit is written through locally by `persistPlanHits`, once the layer it names is durable.
   */
  async plan(planKey: Digest, expected: { destination: string; platform: Platform }, options: {
    bypass?: boolean;
    /** Decides whether a validated candidate is usable here, typically by resolving the `deps` record it names. */
    accept?: (candidate: ClosurePlanRecord) => Promise<boolean>;
  } = {}): Promise<{ record?: ClosurePlanRecord; origin: CacheEvent["status"] }> {
    // `--no-local-cache` and `--no-cache` leave no managed directory, and both mean a clean local
    // flow: without a local index to write a hit through to, no plan is consulted at all.
    if (options.bypass || !this.options.directory) { this.planEvent({ kind: "deps-plan", key: planKey, status: "bypass", reason: "disabled" }); return { origin: "bypass" }; }
    const accept = options.accept ?? (async () => true);
    let unavailable = false;
    // Local first, then the read sources in order. A candidate the caller cannot use — its layer is
    // gone, or its projection covers a selected target — does not end the search: a later source may
    // hold a usable one, and stopping at the first would silently give up the warm path.
    const local = await this.local.plan(planKey, expected);
    if (this.local.planUnavailable(planKey)) unavailable = true;
    if (local && await accept(local)) return this.acceptedPlan(local, { kind: "deps-plan", key: planKey, status: "local" });
    for (const backend of this.readers) {
      const hit = await backend.readPlan?.(planKey, expected);
      if (!hit) continue;
      if (hit.unavailable) unavailable = true;
      if (hit.record && await accept(hit.record)) {
        this.importedPlans.add(planKey);
        return this.acceptedPlan(hit.record, { kind: "deps-plan", key: planKey, status: backend.type, source: backend.destination });
      }
    }
    this.planEvent({ kind: "deps-plan", key: planKey, status: "miss", reason: unavailable ? "invalid-or-unavailable" : "not-found" });
    return { origin: "miss" };
  }
  private acceptedPlan(record: ClosurePlanRecord, event: CacheEvent): { record: ClosurePlanRecord; origin: CacheEvent["status"] } {
    // A plan used from anywhere is a candidate for every write destination, exactly as a layer hit is.
    this.planRecords.set(record.planKey, record);
    this.planEvent(event);
    return { record, origin: event.status };
  }
  private planEvent(event: CacheEvent): void {
    this.events.push(event);
    metric("bunko.cache.lookup.count", "{lookup}", 1, { "bunko.cache.kind": event.kind, "bunko.cache.result": event.status });
  }
  async rememberPlan(input: ClosurePlanRecord): Promise<void> {
    // Store only what a read would accept, so the index can never hold a record this build would
    // later refuse, and so serialisation is proven before anything is written or published.
    let record: ClosurePlanRecord;
    try { record = validateClosurePlan(input, input.planKey, { destination: input.destination, platform: input.platform }); }
    catch { this.options.log("Projected closure produced no reusable plan; the next build reprojects the closure\n"); return; }
    this.planRecords.set(record.planKey, record);
    this.importedPlans.delete(record.planKey);
    await this.local.rememberPlan(record);
  }
  /** Registry plans reach the local cache only after the layer they name is durable there. */
  async persistPlanHits(): Promise<void> {
    for (const planKey of this.importedPlans) await this.local.rememberPlan(this.planRecords.get(planKey)!);
    this.importedPlans.clear();
  }
  async remember(record: CacheRecord): Promise<void> {
    if (canonicalJSON(record).length > cacheMetadataLimit) { this.options.log("Cache metadata exceeds size limit; skipping cache persistence and publication\n"); return; }
    this.records.set(record.key, record); await this.local.remember(record); this.imported.delete(record.key);
  }
  async persistHits(): Promise<void> {
    for (const key of this.imported) await this.local.remember(this.records.get(key)!);
    this.imported.clear();
  }
  async publish(): Promise<void> {
    // Every destination/record pair is independent; run them under the publication bound and
    // report the events in destination-then-record order, as the sequential loop did.
    const writes = this.writers.flatMap((backend) => [...this.records.values()].map((record) => ({ backend, record })));
    const { results, failure } = await boundedMap(writes, this.concurrency, ({ backend, record }) => backend.write(record));
    let failed = false, firstFailure: unknown;
    const unwritten = new Map<CacheBackend, Set<Digest>>();
    for (const [index, outcome] of results.entries()) {
      const write = writes[index]!;
      if (!outcome || outcome.event.status === "failed") {
        if (!unwritten.has(write.backend)) unwritten.set(write.backend, new Set());
        unwritten.get(write.backend)!.add(write.record.key);
      }
      if (!outcome) continue;
      if (outcome.event.status === "failed") { if (!failed) firstFailure = outcome.error; failed = true; }
      this.exports.push(outcome.event);
    }
    // A backend that could not even produce an outcome keeps its original error, after the
    // outcomes its siblings did produce are recorded. A falsy rejection still fails here.
    if (failure) throw failure.reason;
    // A plan is an index, so it is published only after the layer record it names was seen at that
    // destination during this build: a destination that rejected the record never gains a plan for
    // it. That is ordering, not a guarantee — a prune between the two passes can still strand an
    // index — so readers treat a plan whose layer no longer resolves as a miss and reproject.
    const planWrites = this.writers.flatMap((backend) => backend.writePlan ? [...this.planRecords.values()]
      .filter((plan) => this.records.has(plan.key) && !unwritten.get(backend)?.has(plan.key))
      .map((plan) => ({ backend, plan })) : []);
    // An index is never worth an image: even an unexpected rejection becomes a reported failure,
    // so publishing a plan can only fail a build under an explicit `--cache-export-error=fail`.
    const plans = await boundedMap(planWrites, this.concurrency, async ({ backend, plan }) => {
      try { return await backend.writePlan!(plan); }
      catch (error) {
        this.options.log(`Could not publish ${plan.kind} cache (unavailable); image publication is unaffected\n`);
        return { event: { backend: backend.type, destination: backend.destination, kind: plan.kind, key: plan.planKey, status: "failed", reason: "unavailable", bytes: 0, durationMs: 0 } satisfies CacheExportEvent, error };
      }
    });
    for (const outcome of plans.results) {
      if (!outcome) continue;
      if (outcome.event.status === "failed") { if (!failed) firstFailure = outcome.error; failed = true; }
      this.exports.push(outcome.event);
    }
    if (failed && this.options.exportError === "fail") throw new CacheExportError(firstFailure);
  }
}
