import { CacheDriver, CacheConflictError, CacheExportError, cacheMetadataLimit, type CacheExportEvent, type CacheRecord } from "./cache.ts";
import { canonicalCachePath, type CacheLocation } from "./cache-backend-options.ts";
import type { BlobStore } from "../oci/blob-store.ts";
import type { RegistryOptions } from "../oci/registry.ts";
import { canonicalJSON } from "../oci/digest.ts";
import { metric } from "./telemetry.ts";

/** Backends return verified records and materialize their verified blobs in the invocation store. */
export interface CacheBackend {
  readonly type: "registry" | "local";
  readonly destination: string;
  read(...args: Parameters<CacheDriver["get"]>): Promise<{ record?: CacheRecord; unavailable: boolean }>;
  write(record: CacheRecord): Promise<{ event: CacheExportEvent; error?: unknown }>;
}

export function cacheBackend(location: CacheLocation, store: BlobStore, registry: RegistryOptions | undefined, log: (message: string) => void): CacheBackend {
  const destination = location.type === "registry" ? location.repo : location.path;
  const reader = new CacheDriver(store, { ...(location.type === "registry" ? { readRepositories: [location.repo], registry } : { directory: location.path }), lookupMetrics: false, log });
  const verified = new Map<string, CacheRecord>();
  return {
    type: location.type, destination,
    async read(...args) {
      if (location.type === "local") await canonicalCachePath(location.path);
      const record = await reader.get(...args);
      if (record) verified.set(record.key, record);
      return { record, unavailable: reader.events.at(-1)?.reason === "invalid-or-unavailable" };
    },
    async write(record) {
      if (canonicalJSON(record).length > cacheMetadataLimit) {
        const event: CacheExportEvent = { backend: location.type, destination, key: record.key, kind: record.kind, status: "failed", reason: "invalid", bytes: 0, durationMs: 0 };
        recordMetrics(event); return { event, error: new Error("Cache metadata exceeds size limit") };
      }
      if (location.type === "registry") {
        const previous = verified.get(record.key);
        if (previous && Buffer.from(canonicalJSON(previous)).equals(Buffer.from(canonicalJSON(record)))) {
          const event: CacheExportEvent = { backend: "registry", destination, key: record.key, kind: record.kind, status: "already-present", bytes: 0, durationMs: 0 };
          recordMetrics(event); return { event };
        }
        const writer = new CacheDriver(store, { repository: location.repo, exportError: "fail", registry, log });
        await writer.remember(record);
        let failure: unknown;
        try { await writer.publish(); } catch (error) { failure = error instanceof CacheExportError ? error.cause : error; }
        const event = writer.exports[0];
        if (!event) throw new Error("Cache exporter produced no result");
        return { event, error: failure };
      }
      const started = performance.now();
      const event: CacheExportEvent = { backend: "local", destination, key: record.key, kind: record.kind, status: "written", bytes: 0, durationMs: 0 };
      let failure: unknown;
      try {
        await canonicalCachePath(location.path);
        const writer = new CacheDriver(store, { directory: location.path, strictLocal: true, lookupMetrics: false, log });
        const previous = await writer.get(record.key, record.kind, false, { destination: record.destination, platform: record.platform });
        if (previous) {
          if (!Buffer.from(canonicalJSON(previous)).equals(Buffer.from(canonicalJSON(record)))) throw new CacheConflictError("Different output for the same local cache key");
          event.status = "already-present";
        } else {
          // Recheck under the write lock without carrying an earlier invalid-read bypass.
          await new CacheDriver(store, { directory: location.path, strictLocal: true, lookupMetrics: false, log }).remember(record);
          event.bytes = record.layer.descriptor.size + canonicalJSON(record).length;
        }
      } catch (error) {
        failure = error;
        event.status = "failed"; event.reason = error instanceof CacheConflictError ? "conflict" : "unavailable";
        log(`Could not export ${record.kind} local cache (${event.reason})\n`);
      }
      event.durationMs = performance.now() - started;
      recordMetrics(event);
      return { event, error: failure };
    },
  };
}

function recordMetrics(event: CacheExportEvent): void {
  const labels = { "bunko.cache.backend": event.backend, "bunko.cache.kind": event.kind, "bunko.cache.result": event.status, "bunko.cache.reason": event.reason ?? "none" };
  metric("bunko.cache.export.count", "{export}", 1, labels);
  metric("bunko.cache.export.bytes", "By", event.bytes, labels);
  metric("bunko.cache.export.duration", "s", event.durationMs / 1000, labels, true);
}
