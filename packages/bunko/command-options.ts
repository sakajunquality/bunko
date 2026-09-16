/** Reject explicitly supplied options that a command would otherwise ignore. */
export function validateCommandOptions(command: string, names: string[]): void {
  const signing = "sign sign-identity-token sigstore-config sign-tlog";
  const build = "runtime-arg registry-mirror define otel asset-context base-sbom deps-verify-key supply-chain-policy deps-map registry-config publish-concurrency progress image-label image-annotation image-user image-refs repo bare tag tag-conflict push oci-layout tarball local kind kind-cluster base base-layout platform bun-path cache cache-dir cache-repo cache-from cache-to cache-write cache-export-error local-cache registry-cache app-cache install-cache asset-cache runtime-kind runtime-libc runtime-inject runtime-cache insecure-registry dry-run reproducible verify-deterministic git-metadata index jobs mode sbom sbom-evidence provenance sign-key cosign-path report target deps-strategy shared-deps module-locations";
  const input = "filename context recursive selector";
  const kube = "kubectl-path kube-context namespace server-side field-manager kube-dry-run";
  const diagnostic = "deep runtime-arg define asset-context target platform mode module-locations deps-strategy shared-deps format";
  // why/closure-info install Linux production dependencies; they take the install cache but no image registry options.
  const closure = "target platform deps-strategy shared-deps bun-path install-cache cache local-cache json";
  const allowed: Record<string, string> = {
    build: `offline ${build} ${signing} deps-artifact`, resolve: `${build} ${signing} ${input}`, apply: `${build} ${signing} ${input} ${kube}`,
    "auth-check": "auth-source scope registry-config insecure-registry",
    "cache-info": "cache-dir",
    "base-status": "targets base-tag old-base platform compatibility-policy json registry-mirror insecure-registry registry-config",
    "rebase-policy": "old-base base out platform runtime-libc registry-mirror insecure-registry registry-config",
    rebase: `${signing} smoke-command old-base compatibility-policy base base-layout platform oci-layout repo push tag tag-conflict dry-run report sbom base-sbom provenance sign-key cosign-path registry-mirror insecure-registry registry-config publish-concurrency`,
    metadata: "registry-mirror metadata-dir insecure-registry registry-config",
    "push-layout": "repo tag tag-conflict insecure-registry registry-config publish-concurrency report", prune: "cache-dir cache-repo older-than keep-bytes execute dry-run insecure-registry registry-config",
    "prepare-base": "base base-layout platform oci-layout registry-mirror insecure-registry registry-config",
    "pack-deps": "lockfile platform oci-layout workdir artifact-target", "check-base": "requirements-report registry-mirror base base-layout platform bun-path run runtime-path runtime-kind runtime-libc runtime-inject runtime-cache insecure-registry registry-config",
    verify: "verify-key private-signatures cosign-path insecure-registry certificate-identity certificate-identity-regexp certificate-oidc-issuer certificate-oidc-issuer-regexp sigstore-config use-signed-timestamps", "check-config": diagnostic, doctor: `${diagnostic} bun-path cosign-path`, version: "",
    why: closure, "closure-info": `${closure} top`,
  };
  if (!(command in allowed)) throw new Error(`Unknown command: ${command}`);
  const auth = ["build", "resolve", "apply", "base-status", "rebase-policy", "rebase", "metadata", "push-layout", "prune", "prepare-base", "check-base", "verify"].includes(command) ? "auth-source" : "";
  const accepted = new Set(`${allowed[command]} ${auth} help version`.split(" "));
  for (const name of names) {
    const normalized = name.replace(/^no-/, "");
    if (!accepted.has(normalized)) throw new Error(`--${name} is not supported by ${command}`);
  }
}
