import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalOutput } from "../oci/layout.ts";
import type { BuildOptions } from "./config.ts";

/**
 * Bun's package download cache. An explicit `--install-cache` always wins.
 * Otherwise the cache persists beside the layer and runtime caches so repeated
 * builds do not re-download every package and are less exposed to transient
 * registry failures; `--no-cache`/`--no-local-cache` return `undefined`, which
 * keeps the per-build temporary staging directory.
 */
export async function installCachePath(options: Pick<BuildOptions, "installCache" | "localCache">): Promise<string | undefined> {
  if (options.installCache) return canonicalOutput(options.installCache);
  if (options.localCache === false) return undefined;
  return canonicalOutput(join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "bunko", "install", "v1"));
}
