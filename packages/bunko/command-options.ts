/** Reject explicitly supplied options that a command would otherwise ignore. */
export function validateCommandOptions(command: string, names: string[]): void {
  const build = "repo bare tag push oci-layout tarball local kind kind-cluster base base-layout platform bun-path cache cache-dir cache-repo local-cache registry-cache app-cache install-cache insecure-registry dry-run reproducible verify-deterministic git-metadata index jobs mode sbom provenance sign-key cosign-path report target deps-strategy shared-deps";
  const input = "filename context recursive";
  const kube = "kubectl-path kube-context namespace server-side field-manager kube-dry-run";
  const diagnostic = "target platform mode deps-strategy shared-deps";
  const allowed: Record<string, string> = {
    build: `${build} deps-artifact`, resolve: `${build} ${input}`, apply: `${build} ${input} ${kube}`,
    "push-layout": "repo tag insecure-registry report", prune: "cache-dir cache-repo older-than execute dry-run insecure-registry",
    "pack-deps": "lockfile platform oci-layout workdir", "check-base": "base base-layout platform bun-path run runtime-path insecure-registry",
    verify: "verify-key private-signatures cosign-path insecure-registry", "check-config": diagnostic, doctor: `${diagnostic} bun-path cosign-path`, version: "",
  };
  if (!(command in allowed)) throw new Error(`Unknown command: ${command}`);
  const accepted = new Set(`${allowed[command]} help version`.split(" "));
  for (const name of names) {
    const normalized = name.replace(/^no-/, "");
    if (!accepted.has(normalized)) throw new Error(`--${name} is not supported by ${command}`);
  }
}
