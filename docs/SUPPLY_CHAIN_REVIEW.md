# Supply-chain and compile validation and review

Historical review snapshot for [PR #11](https://github.com/sakajunquality/bunko/pull/11); test counts and runtime results describe that change, not the current total.

Validated on 2026-09-08 with Bun 1.3.11 and cosign 3.1.3. Repository visibility remains private.

- Independent compiled outputs matched on linux/amd64 and linux/arm64. Both images ran in Docker with read-only filesystems, no network, nonroot users, and dropped capabilities.
- Pinned Bun distroless bases returned the exact selected Bun revision on both architectures.
- Distribution 3 accepted subject artifacts through its referrers API. Disposable local keys signed and verified the root, platform, and artifact manifests. Public signing configuration and transparency-log upload were disabled.
- Generated SPDX validated against the official SPDX 2.3 JSON schema. Payload tests verify subject digests, exclusion of unused development packages, and absence of checkout paths.
- Unit tests cover fallback referrer retention, immutable signing targets, incomplete attachment failure reports, and cosign environment filtering. Distribution preparation and isolated bundled CLI tests passed.

Claude Code reviewed the implementation read-only. Actionable findings addressed:

1. Explicitly disable cosign v3's public signing configuration in addition to transparency-log upload.
2. Filter signing environments so COSIGN_REPOSITORY and public service overrides cannot redirect private signatures. Preserve selected Docker configuration and credential-helper settings.
3. Preserve successful image publication records when an artifact's publication fails; report the incomplete supply-chain phase.
4. Reject implicit non-publishing API builds when signing is requested.
5. Forward explicit HTTP-registry permission to cosign without disabling TLS verification.
6. Use SPDX timestamps without fractional seconds.
7. Preserve foreign fallback descriptors and follow bounded, same-subject referrer pagination.
8. Use Docker's canonical Hub repository spelling during base runtime checks.

Cosign subprocess errors include the command phase and exit code, but deliberately omit raw helper stderr because it may contain credentials. Private-key verification does not establish public transparency or timestamp guarantees. Concurrent cross-process referrer tag updates remain subject to registry tag semantics. Cloud referrer/signature interoperability is not established by the local Distribution test.
