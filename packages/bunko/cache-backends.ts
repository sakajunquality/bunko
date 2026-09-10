import { CacheDriver, CacheConflictError, type CacheExportEvent, type CacheRecord } from "./cache.ts";
import type { CacheLocation } from "./cache-backend-options.ts";
import type { BlobStore } from "../oci/blob-store.ts";
import type { RegistryOptions } from "../oci/registry.ts";
import { canonicalJSON } from "../oci/digest.ts";
import { metric } from "./telemetry.ts";

/** Backends return verified records and materialize their verified blobs in the invocation store. */
export interface CacheBackend {
  readonly type: "registry" | "local";
  readonly destination: string;
  read(...args: Parameters<CacheDriver["get"]>): Promise<{ record?: CacheRecord; unavailable: boolean }>;
  write(record: CacheRecord): Promise<CacheExportEvent>;
}

export function cacheBackend(location: CacheLocation, store: BlobStore, registry: RegistryOptions | undefined, log: (message: string) => void): CacheBackend {
  const destination = location.type === "registry" ? location.repo : location.path;
  const reader = new CacheDriver(store, { ...(location.type === "registry" ? { readRepositories: [location.repo], registry } : { directory: location.path }), lookupMetrics: false, log });
  const verified = new Map<string, CacheRecord>();
  return {
    type: location.type, destination,
    async read(...args) {
      const record = await reader.get(...args);
      if (record) verified.set(record.key, record);
      return { record, unavailable: reader.events.at(-1)?.reason === "invalid-or-unavailable" };
    },
    async write(record) {
      if (location.type === "registry") {
        const previous = verified.get(record.key);
        if (previous && Buffer.from(canonicalJSON(previous)).equals(Buffer.from(canonicalJSON(record)))) {
          const event: CacheExportEvent = { backend: "registry", destination, key: record.key, kind: record.kind, status: "already-present", bytes: 0, durationMs: 0 };
          recordMetrics(event); return event;
        }
        const writer = new CacheDriver(store, { repository: location.repo, registry, log });
        await writer.remember(record); await writer.publish();
        return writer.exports[0]!;
      }
      const started = performance.now();
      const event: CacheExportEvent = { backend: "local", destination, key: record.key, kind: record.kind, status: "written", bytes: 0, durationMs: 0 };
      try {
        const writer = new CacheDriver(store, { directory: location.path, strictLocal: true, lookupMetrics: false, log });
        const previous = await writer.get(record.key, record.kind, false, { destination: record.destination, platform: record.platform });
        if (previous) {
          if (!Buffer.from(canonicalJSON(previous)).equals(Buffer.from(canonicalJSON(record)))) throw new CacheConflictError("Different output for the same local cache key");
          event.status = "already-present";
        } else {
          await new CacheDriver(store, { directory: location.path, strictLocal: true, lookupMetrics: false, log }).remember(record);
          event.bytes = record.layer.descriptor.size + canonicalJSON(record).length;
        }
      } catch (error) {
        event.status = "failed"; event.reason = error instanceof CacheConflictError ? "conflict" : "unavailable";
        log(`Could not export ${record.kind} local cache (${event.reason})\n`);
      }
      event.durationMs = performance.now() - started;
      recordMetrics(event);
      return event;
    },
  };
}

function recordMetrics(event: CacheExportEvent): void {
  const labels = { "bunko.cache.backend": event.backend, "bunko.cache.kind": event.kind, "bunko.cache.result": event.status, "bunko.cache.reason": event.reason ?? "none" };
  metric("bunko.cache.export.count", "{export}", 1, labels);
  metric("bunko.cache.export.bytes", "By", event.bytes, labels);
  metric("bunko.cache.export.duration", "s", event.durationMs / 1000, labels, true);
}
