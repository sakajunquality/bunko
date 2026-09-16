# v0.9.0

This release adds explicit registry credential sources and local credential management while preserving Docker-compatible authentication by default. Enable `github`, `google`, or `podman` with `--auth-source` or `BUNKO_AUTH_SOURCES`; native cloud discovery remains opt-in. `auth-check` reports authentication without claiming repository permissions, and `login`/`logout` safely update local credentials or the selected helper. Build and rebase Actions accept `auth-sources`. Native AWS/ECR authentication is deferred in #198; existing Docker ECR helpers remain supported.

Changes since v0.8.3 also include:

- Opt-in SBOM build evidence with package inclusion states and lock checksums. Evidence does not claim tree-shaken code reachability or replace an OS scanner.
- Expanded rebase operations and safety/acceptance checks. Runtime identity and ABI compatibility boundaries remain enforced; rebase is not a runtime upgrade mechanism.
- Node runtime images with explicit runtime selection and documented compatibility boundaries.
- Keyless signing and certificate-identity verification through cosign, with explicit trust and OIDC configuration.

Bun >=1.3.13 <1.5 remains supported. GHCR and Artifact Registry token-based publication were verified; Google workload metadata and AWS workload identity are not certified by those checks. See [registry validation](https://github.com/sakajunquality/bunko/blob/main/docs/validation/registry-credentials.md) and [release evidence](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.9.0.md).

The independently versioned setup-bunko v0.1.1 Action still defaults to CLI v0.8.0. Select `version: v0.9.0` explicitly after publication.
