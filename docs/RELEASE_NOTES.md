# Unreleased private preview — v0.1.0-alpha.1

This candidate completes the private M3–M6 implementation and portable ko workflow additions. No public package or release has been published.

- Build deterministic OCI images from standalone Bun applications and workspaces, with production dependencies, explicit closures or validated prepared dependency artifacts.
- Bundle JavaScript or compile Linux executables for amd64/arm64; export OCI layouts/Docker archives and load Docker/kind images.
- Prepare targets with bounded jobs and reuse verified application/dependency/asset layers. Registry cache corruption is detected during preparation; cache conflicts are not silently overwritten.
- Attach SPDX inventories and SLSA provenance, and sign/verify image/artifact digests through explicit private cosign keys without public transparency-log upload.
- Resolve/apply YAML/JSON with immutable references, optional label selectors and reference-list files. Preview cache pruning before explicit deletion.
- Inspect configuration/toolchains with check-config/doctor and validate base runtime revisions with check-base.
- Set CLI labels, OCI annotations and runtime users; include conventional bunkodata alongside explicit assets.

The CLI distribution contains bunko.js, SHA256SUMS, LICENSE (MIT) and THIRD_PARTY_NOTICES.md. It requires Bun >=1.3.11 <1.4; CI pins 1.3.11 and 1.3.12 on Linux/macOS. No external npm runtime dependencies are required. YAML and TypeScript parser licenses are included.

This remains an alpha with explicit Bun/lock/native-package limits. SBOM scope does not include base OS packages. GHCR/GAR have live interoperability evidence; Docker Hub account push and ECR remain unverified. See COMPATIBILITY.md, SUPPLY_CHAIN.md, OPERATIONS.md and KO_GAPS.md for migration contracts and deliberate limitations. Repository visibility remains private.
