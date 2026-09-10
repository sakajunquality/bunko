import { cacheMetadataLimit, closurePlanLayout, packFormat } from "./cache.ts";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertDigest, canonicalJSON, descriptor, object, sha256 } from "../oci/digest.ts";
import { Publisher } from "../oci/publish.ts";
import { responseBytes, type RegistryOptions } from "../oci/registry.ts";
import { media } from "../oci/types.ts";
import { withCacheLock } from "./cache-lock.ts";

export interface PruneResult { dryRun: boolean; keys: string[]; blobs: string[]; deleted: string[]; bytes: number; managedBytes: number; remainingBytes: number }

export async function pruneLocal(directory: string, execute = false, olderThanSeconds = 7 * 86400, keepBytes?: number): Promise<PruneResult> {
  if (!Number.isSafeInteger(olderThanSeconds) || olderThanSeconds < 0) throw new Error("Prune age must be non-negative integer seconds");
  if (keepBytes !== undefined && (!Number.isSafeInteger(keepBytes) || keepBytes < 0)) throw new Error("Cache budget must be non-negative integer bytes");
  const result: PruneResult = { dryRun: !execute, keys: [], blobs: [], deleted: [], bytes: 0, managedBytes: 0, remainingBytes: 0 };
  try { await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
  return withCacheLock(directory, async () => {
    for (const path of ["keys", "plans", "plans/deps", "blobs", "blobs/sha256"]) {
      try { const info = await lstat(join(directory, path)); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Prune refuses symlinked or non-directory cache paths"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { if ((await readdir(join(directory, "keys"))).some((name) => !["deps", "assets", "app", "runtime"].includes(name))) throw new Error("Prune refuses unknown cache key namespaces"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { if ((await readdir(join(directory, "plans"))).some((name) => name !== "deps")) throw new Error("Prune refuses unknown cache plan namespaces"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const cutoff = Date.now() - olderThanSeconds * 1000;
    const records: { path: string; key: string; digest: string; bytes: Uint8Array; mtime: number }[] = [];
    const safeRead = async (path: string) => { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > cacheMetadataLimit) throw new Error("Prune refuses non-regular or oversized cache metadata"); return { info, bytes: await readFile(path) }; };
    for (const kind of ["deps", "assets", "app", "runtime"]) {
      const dir = join(directory, "keys", kind);
      let names: string[];
      try { if ((await lstat(dir)).isSymbolicLink()) throw new Error("Prune refuses symlinked cache directories"); names = await readdir(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const name of names.sort()) {
        if (name.startsWith(".tmp-")) continue;
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Prune refuses unknown cache records");
        const path = join(dir, name), { info, bytes } = await safeRead(path), value = object(JSON.parse(bytes.toString()), "Cache key");
        const layer = object(value.layer, "Cache layer"), blob = descriptor(layer.descriptor);
        if (value.schemaVersion !== 1 || value.key !== `sha256:${name.slice(0, 64)}` || value.kind !== kind || layer.kind !== kind || typeof value.packFormat !== "string") throw new Error("Prune refuses inconsistent cache metadata");
        records.push({ path, key: `${kind}/${name}`, digest: blob.digest, bytes, mtime: info.mtimeMs });
      }
    }
    // Closure plans index key records; they own no blobs and are dropped with the record they name.
    const plans: { path: string; key: string; target: string; bytes: Uint8Array; mtime: number; stale: boolean }[] = [];
    {
      const dir = join(directory, "plans", "deps");
      let names: string[] = [];
      try { if ((await lstat(dir)).isSymbolicLink()) throw new Error("Prune refuses symlinked cache directories"); names = await readdir(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const name of names.sort()) {
        if (name.startsWith(".tmp-")) continue;
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Prune refuses unknown cache records");
        const path = join(dir, name), { info, bytes } = await safeRead(path), value = object(JSON.parse(bytes.toString()), "Closure plan");
        if (value.schemaVersion !== 1 || value.kind !== "deps-plan" || value.planKey !== `sha256:${name.slice(0, 64)}` || typeof value.packFormat !== "string") throw new Error("Prune refuses inconsistent cache metadata");
        assertDigest(value.key);
        plans.push({ path, key: `plans/deps/${name}`, target: `deps/${value.key.slice(7)}.json`, bytes, mtime: info.mtimeMs, stale: value.layout !== closurePlanLayout || value.packFormat !== packFormat });
      }
    }
    // Account only for validated metadata and its referenced blobs. Unreferenced
    // CAS files and unrelated content are outside this managed-byte budget.
    const sizes = new Map<string, number>(), references = new Map<string, number>(), present = new Set<string>();
    for (const plan of plans) result.managedBytes += plan.bytes.byteLength;
    for (const record of records) {
      result.managedBytes += record.bytes.byteLength;
      references.set(record.digest, (references.get(record.digest) ?? 0) + 1);
      if (sizes.has(record.digest)) continue;
      try {
        const info = await lstat(join(directory, "blobs", "sha256", record.digest.slice(7)));
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Prune refuses non-regular blobs");
        sizes.set(record.digest, info.size); present.add(record.digest); result.managedBytes += info.size;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; sizes.set(record.digest, 0); }
    }
    result.remainingBytes = result.managedBytes;
    const candidates: typeof records = [];
    // A plan is only useful while the record it names survives, so its bytes are reclaimed with
    // that record and must be credited as the budget is spent, not after the selection ends.
    const known = new Set(records.map((record) => record.key)), attached = new Map<string, typeof plans>();
    const reclaim = (plan: (typeof plans)[number]) => {
      candidates.push({ ...plan, digest: "" }); result.keys.push(plan.key);
      result.bytes += plan.bytes.byteLength; result.remainingBytes -= plan.bytes.byteLength;
    };
    for (const plan of plans) {
      if (plan.stale || !known.has(plan.target)) { reclaim(plan); continue; }
      attached.set(plan.target, [...attached.get(plan.target) ?? [], plan]);
    }
    for (const record of records.sort((a, b) => a.mtime - b.mtime || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
      if (keepBytes === undefined ? record.mtime > cutoff : result.remainingBytes <= keepBytes) continue;
      candidates.push(record); result.keys.push(record.key);
      result.bytes += record.bytes.byteLength; result.remainingBytes -= record.bytes.byteLength;
      for (const plan of attached.get(record.key) ?? []) reclaim(plan);
      const count = references.get(record.digest)! - 1; references.set(record.digest, count);
      if (count === 0 && present.has(record.digest)) {
        result.blobs.push(record.digest); result.bytes += sizes.get(record.digest)!; result.remainingBytes -= sizes.get(record.digest)!;
      }
    }
    if (execute) {
      for (const candidate of candidates) if (sha256((await safeRead(candidate.path)).bytes) !== sha256(candidate.bytes)) throw new Error("Cache changed during prune");
      // A crash leaves removable dangling keys rather than unreclaimable blobs.
      for (const digest of result.blobs) { const path = join(directory, "blobs", "sha256", digest.slice(7)); await rm(path); result.deleted.push(path); }
      for (const candidate of candidates) { await rm(candidate.path); result.deleted.push(candidate.path); }
    }
    return result;
  });
}

/** Delete only selected owned tags; never fall back to manifest/blob deletion. */
export async function pruneRegistry(repository: string, execute = false, registry: RegistryOptions = {}) {
  const publisher = new Publisher(repository, registry), tags = new Set<string>();
  const scope = `repository:${publisher.ref.repository}:pull`;
  const path = `/v2/${publisher.ref.repository}/tags/list`;
  let url = new URL(`${path}?n=100`, publisher.client.origin);
  const visited = new Set<string>();
  while (true) {
    if (visited.has(url.href) || visited.size >= 1000) throw new Error("Invalid tag pagination");
    visited.add(url.href);
    const response = await publisher.client.request(url, {}, [scope]);
    const value = object(JSON.parse(Buffer.from(await responseBytes(response)).toString()), "Tag list");
    if (value.tags != null && (!Array.isArray(value.tags) || !value.tags.every((v) => typeof v === "string"))) throw new Error("Invalid tag list");
    for (const tag of value.tags as string[] ?? []) if (/^bunko-cache-v1-(?:deps|assets|app|runtime)-[a-f0-9]{64}$/.test(tag)) tags.add(tag);
    const link = response.headers.get("Link"); if (!link) break;
    const next = /<([^>]+)>;\s*rel="?next"?/.exec(link)?.[1];
    if (!next) throw new Error("Invalid tag pagination Link");
    const destination = new URL(next, url);
    if (destination.origin !== url.origin || destination.pathname !== path) throw new Error("Tag pagination escaped repository");
    url = destination;
  }
  const selected: { tag: string; digest: string }[] = [];
  for (const tag of [...tags].sort()) {
    const response = await publisher.client.request(`/v2/${publisher.ref.repository}/manifests/${tag}`, {}, [scope]);
    const bytes = await responseBytes(response), manifest = object(JSON.parse(Buffer.from(bytes).toString()), "Cache manifest");
    const [, kind, key] = /^bunko-cache-v1-(deps|assets|app|runtime)-([a-f0-9]{64})$/.exec(tag)!;
    if (manifest.mediaType !== media.manifest || manifest.artifactType !== "application/vnd.bunko.cache.v1" || !Array.isArray(manifest.layers) || manifest.layers.length !== 1) throw new Error("Prune refuses a cache-named tag with unrelated content");
    const config = descriptor(manifest.config);
    if (config.mediaType !== "application/vnd.bunko.cache.config.v1+json") throw new Error("Invalid cache configuration type");
    const responseConfig = await publisher.client.request(`/v2/${publisher.ref.repository}/blobs/${config.digest}`, {}, [scope]);
    const configBytes = await responseBytes(responseConfig);
    if (sha256(configBytes) !== config.digest || configBytes.length !== config.size) throw new Error("Cache configuration digest mismatch");
    const value = object(JSON.parse(Buffer.from(configBytes).toString()), "Cache config");
    if (value.schemaVersion !== 1 || value.kind !== kind || value.key !== `sha256:${key}` || Buffer.compare(Buffer.from(canonicalJSON(object(value.layer, "Cache layer").descriptor)), Buffer.from(canonicalJSON(manifest.layers[0])))) throw new Error("Cache tag and configuration disagree");
    selected.push({ tag, digest: sha256(bytes) });
  }
  const deleted: string[] = [];
  for (const item of execute ? selected : []) {
    const path = `/v2/${publisher.ref.repository}/manifests/${item.tag}`;
    const response = await publisher.client.request(path, {}, [scope]);
    if (sha256(await responseBytes(response)) !== item.digest) throw new Error("Cache tag changed during prune");
    const removal = await publisher.client.request(path, { method: "DELETE" }, [`repository:${publisher.ref.repository}:pull,delete`], [400, 404, 405]);
    await removal.body?.cancel();
    if (removal.status !== 202) throw new Error("Registry does not support tag-only deletion; use its retention policy. No manifest deletion was attempted");
    deleted.push(item.tag);
  }
  return { dryRun: !execute, tags: selected, deleted, note: "Remote selection includes all validated bunko cache tags; retention age and reclaimed space are provider-specific." };
}
