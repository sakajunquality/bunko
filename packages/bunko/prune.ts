import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJSON, descriptor, object, sha256 } from "../oci/digest.ts";
import { Publisher } from "../oci/publish.ts";
import { responseBytes, type RegistryOptions } from "../oci/registry.ts";
import { media } from "../oci/types.ts";
import { withCacheLock } from "./cache-lock.ts";

export interface PruneResult { dryRun: boolean; keys: string[]; blobs: string[]; deleted: string[]; bytes: number }

export async function pruneLocal(directory: string, execute = false, olderThanSeconds = 7 * 86400): Promise<PruneResult> {
  if (!Number.isSafeInteger(olderThanSeconds) || olderThanSeconds < 0) throw new Error("Prune age must be non-negative integer seconds");
  const result: PruneResult = { dryRun: !execute, keys: [], blobs: [], deleted: [], bytes: 0 };
  try { await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
  return withCacheLock(directory, async () => {
    for (const path of ["keys", "blobs", "blobs/sha256"]) {
      try { const info = await lstat(join(directory, path)); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Prune refuses symlinked or non-directory cache paths"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { if ((await readdir(join(directory, "keys"))).some((name) => !["deps", "assets", "app"].includes(name))) throw new Error("Prune refuses unknown cache key namespaces"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const cutoff = Date.now() - olderThanSeconds * 1000;
    const kept = new Set<string>();
    const candidates: { path: string; digest: string; bytes: Uint8Array }[] = [];
    const safeRead = async (path: string) => { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Prune refuses non-regular cache metadata"); return { info, bytes: await readFile(path) }; };
    for (const kind of ["deps", "assets", "app"]) {
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
        if (info.mtimeMs <= cutoff) { candidates.push({ path, digest: blob.digest, bytes }); result.keys.push(`${kind}/${name}`); }
        else kept.add(blob.digest);
      }
    }
    // Only blobs referenced by selected, validated keys are eligible. Unknown
    // files and unrelated CAS contents are never guessed to be garbage.
    const blobs = new Set(candidates.map((c) => c.digest));
    for (const digest of blobs) if (!kept.has(digest)) {
      const path = join(directory, "blobs", "sha256", digest.slice(7));
      try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Prune refuses non-regular blobs"); result.blobs.push(digest); result.bytes += info.size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
    for (const tag of value.tags as string[] ?? []) if (/^bunko-cache-v1-(?:deps|assets|app)-[a-f0-9]{64}$/.test(tag)) tags.add(tag);
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
    const [, kind, key] = /^bunko-cache-v1-(deps|assets|app)-([a-f0-9]{64})$/.exec(tag)!;
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
