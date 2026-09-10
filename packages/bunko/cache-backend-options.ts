import { lstat } from "node:fs/promises";
import { canonicalOutput } from "../oci/layout.ts";
import { dirname, resolve } from "node:path";
import { repository, repositoryName } from "../oci/publish.ts";

export type CacheLocation = { type: "registry"; repo: string } | { type: "local"; path: string };
/** Bunko cache locations describe storage, not BuildKit cache manifests. */
export function cacheLocation(value: string, direction: "from" | "to"): CacheLocation {
  if (typeof value !== "string" || !value || value !== value.trim()) throw new Error(`Invalid --cache-${direction} location`);
  if (!value.includes("=")) return { type: "registry", repo: repositoryName(repository(value)) };
  const fields = new Map<string, string>();
  for (const item of value.split(",")) {
    const separator = item.indexOf("="), key = item.slice(0, separator), content = item.slice(separator + 1);
    if (separator < 1 || !content || content !== content.trim() || fields.has(key)) throw new Error(`Invalid --cache-${direction} location`);
    fields.set(key, content);
  }
  const type = fields.get("type"), pathKey = direction === "from" ? "src" : "dest", property = type === "registry" ? "repo" : pathKey;
  if (type !== "registry" && type !== "local") throw new Error("Supported cache types are registry and local");
  if (fields.size !== 2 || !fields.has(property)) throw new Error(`Cache type=${type} requires only type and ${property}`);
  return type === "registry" ? { type, repo: repositoryName(repository(fields.get(property)!)) } : { type, path: resolve(fields.get(property)!) };
}
export function cacheLocations(values: string[] | undefined, direction: "from" | "to"): CacheLocation[] {
  const maximum = direction === "from" ? 32 : 8;
  if (values !== undefined && (!Array.isArray(values) || values.length > maximum)) throw new Error(`Use at most ${maximum} cache ${direction === "from" ? "read sources" : "write destinations"}`);
  return [...new Map((values ?? []).map((value) => { const location = cacheLocation(value, direction); return [JSON.stringify(location), location]; })).values()];
}

/** Existing leaf symlinks must not bypass cache-root overlap checks. */
export async function canonicalCachePath(path: string): Promise<string> {
  const canonical = await canonicalOutput(path);
  if (dirname(canonical) === canonical) throw new Error("A filesystem root cannot be used as an explicit cache location");
  try {
    if ((await lstat(canonical)).isSymbolicLink()) throw new Error("Explicit cache roots must not be symbolic links");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return canonical;
}
