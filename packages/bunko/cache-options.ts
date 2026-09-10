import { repository } from "../oci/publish.ts";
import type { BuildOptions } from "./config.ts";

export function validateCacheOptions(options: Partial<BuildOptions>): void {
  if (options.cacheExportError !== undefined && !["warn", "fail"].includes(options.cacheExportError)) throw new Error("--cache-export-error must be warn or fail");
  if (options.cacheExportError === "fail" && (options.registryCache === false || options.cacheWrite === false)) throw new Error("Strict cache export requires registry caching and cache writes");
  if (options.cacheExportError === "fail" && (options.offline || options.dryRun)) throw new Error("Strict cache export cannot be combined with --offline or --dry-run");
  if (options.runtimeCache && options.localCache === false) throw new Error("--runtime-cache requires local caching");
  if (options.cacheFrom && (!Array.isArray(options.cacheFrom) || options.cacheFrom.length > 32)) throw new Error("Use at most 32 cache read repositories");
  if (options.registryCache === false && options.cacheFrom?.length) throw new Error("--cache-from requires registry caching");
  for (const value of options.cacheFrom ?? []) repository(value);
  const destination = options.cacheRepo ?? (options.registryCache === false ? undefined : process.env.BUNKO_CACHE_REPO);
  if (destination) repository(destination);
}
