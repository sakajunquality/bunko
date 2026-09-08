import type { BuildOptions } from "./config.ts";

export function supplyChainOptions<T extends Partial<BuildOptions>>(options: T): T {
  if (options.supplyChainPolicy !== undefined && options.supplyChainPolicy !== "ci") throw new Error("Unknown supply-chain policy");
  if (options.supplyChainPolicy === "ci") {
    if (options.sbom === false || options.provenance === false || !options.reproducible || !options.signKey) throw new Error("CI policy requires SBOM, provenance, --reproducible and --sign-key");
    if ((options.externalDeps || options.externalDepsByTarget) && !options.depsVerifyKey) throw new Error("CI policy requires --deps-verify-key for prepared dependencies");
    options = { ...options, sbom: true, provenance: true };
  }
  if (options.baseSBOMs && !options.sbom) throw new Error("--base-sbom requires --sbom");
  if (options.depsVerifyKey && !(options.externalDeps || options.externalDepsByTarget)) throw new Error("--deps-verify-key requires prepared dependencies");
  if (options.depsVerifyKey && options.registry?.tls && Object.keys(options.registry.tls).length) throw new Error("Dependency signature verification cannot use Registry TLS configuration");
  return options;
}
