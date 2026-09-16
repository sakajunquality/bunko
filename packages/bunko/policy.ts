import { signingMode } from "./keyless.ts";
import type { BuildOptions } from "./config.ts";

export function supplyChainOptions<T extends Partial<BuildOptions>>(options: T): T {
  const signing = signingMode(options);
  if (options.supplyChainPolicy !== undefined && options.supplyChainPolicy !== "ci") throw new Error("Unknown supply-chain policy");
  if (options.supplyChainPolicy === "ci") {
    if (options.sbom === false || options.provenance === false || !options.reproducible || !signing) throw new Error("CI policy requires SBOM, provenance, --reproducible and signing (--sign-key or --sign keyless)");
    if ((options.externalDeps || options.externalDepsByTarget) && !options.depsVerifyKey) throw new Error("CI policy requires --deps-verify-key for prepared dependencies");
    options = { ...options, sbom: true, provenance: true };
  }
  if (options.sbomEvidence && !options.sbom) throw new Error("--sbom-evidence requires --sbom");
  if (options.baseSBOMs && !options.sbom) throw new Error("--base-sbom requires --sbom");
  if (options.depsVerifyKey && !(options.externalDeps || options.externalDepsByTarget)) throw new Error("--deps-verify-key requires prepared dependencies");
  if (options.depsVerifyKey && options.registry?.tls && Object.keys(options.registry.tls).length) throw new Error("Dependency signature verification cannot use Registry TLS configuration");
  return options;
}
