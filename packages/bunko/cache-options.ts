import { repository } from "../oci/publish.ts";
import type { BuildOptions } from "./config.ts";

export function validateCacheOptions(options: Partial<BuildOptions>): void {
  if (options.cacheFrom && (!Array.isArray(options.cacheFrom) || options.cacheFrom.length > 32)) throw new Error("Use at most 32 cache read repositories");
  if (options.registryCache === false && options.cacheFrom?.length) throw new Error("--cache-from requires registry caching");
  for (const value of options.cacheFrom ?? []) repository(value);
  const destination = options.cacheRepo ?? (options.registryCache === false ? undefined : process.env.BUNKO_CACHE_REPO);
  if (destination) repository(destination);
}
