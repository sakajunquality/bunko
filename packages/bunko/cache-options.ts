import { cacheLocations } from "./cache-backend-options.ts";
import { repository } from "../oci/publish.ts";
import type { BuildOptions } from "./config.ts";

export function validateCacheOptions(options: Partial<BuildOptions>): void {
  if (options.cacheExportError !== undefined && !["warn", "fail"].includes(options.cacheExportError)) throw new Error("--cache-export-error must be warn or fail");
  if (options.cacheExportError === "fail" && (options.cacheWrite === false)) throw new Error("Strict cache export requires cache writes");
  if (options.cacheExportError === "fail" && (options.offline || options.dryRun)) throw new Error("Strict cache export cannot be combined with --offline or --dry-run");
  if (options.runtimeCache && options.localCache === false) throw new Error("--runtime-cache requires local caching");
  const sources = cacheLocations(options.cacheFrom, "from"), destinations = cacheLocations(options.cacheTo, "to");
  if (options.registryCache === false && [...sources, ...destinations].some((item) => item.type === "registry")) throw new Error("--cache-from/--cache-to requires registry caching");
  if (options.localCache === false && [...sources, ...destinations].some((item) => item.type === "local")) throw new Error("Local cache locations require local caching");
  const destination = options.cacheRepo ?? (options.registryCache === false ? undefined : process.env.BUNKO_CACHE_REPO);
  if (destination) repository(destination);
}
