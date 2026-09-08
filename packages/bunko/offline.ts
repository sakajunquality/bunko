import type { BuildOptions } from "./config.ts";

/** Offline builds consume local inputs and verified cache entries, never implicit downloads. */
export function offlineOptions(options: BuildOptions): BuildOptions {
  if (!options.offline) return options;
  if (!options.baseLayout) throw new Error("Offline builds require --base-layout; prepare it with prepare-base while online");
  if (options.push || options.local || options.kind || options.signKey || options.depsVerifyKey || options.supplyChainPolicy) throw new Error("Offline builds cannot publish, load into container engines or invoke signature services");
  if (options.registryCache === true || options.cacheRepo || options.cacheFrom?.length) throw new Error("Offline builds cannot use registry caches");
  const references = [...Object.values(options.externalDeps ?? {}), ...Object.values(options.externalDepsByTarget ?? {}).flatMap(Object.values), ...Object.values(options.baseSBOMs ?? {})];
  if (references.some((reference) => !reference.startsWith("layout:"))) throw new Error("Offline dependency and SBOM inputs must use local layouts");
  return { ...options, push: false, registryCache: false, registry: { ...options.registry, fetcher: async () => { throw new Error("Registry network access is disabled in offline mode"); }, credentials: async () => undefined, retries: 0 } };
}
