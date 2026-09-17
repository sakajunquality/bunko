# v0.12.2

This patch redacts credential-shaped data and random build scratch paths from CLI errors and failure reports. Native dependency diagnostics now recognize paired sharp-style `linuxmusl` and implicit glibc addon names using ELF requirements. Binaries remain included; advisory suppression requires a matching alternative for the base libc and does not prove runtime ABI compatibility.

Documentation clarifies supported parser syntax and measured performance, Bun compatibility ranges, compile assets/runtime arguments, and cache behavior. Host Bun support remains `>=1.3.13 <1.4 || >=1.4.2 <1.5`; no new cache or image format migration is introduced.

# v0.12.1

This patch release hardens cancellation scratch retention, deferred import handling, cache identity/pruning safety, Docker credential matching and CI fixture reproducibility. Runtime-layer cache validation continues to authenticate the uncompressed DiffID while allowing equivalent compressed repacks, so a runtime descriptor digest can change without a runtime-content change.

# v0.12.0

Cache writes now use OS-backed crash recovery and leased staging. Local prune can explicitly reclaim old owned residue, while unknown layouts and references are retained conservatively. Packing identity is independent of CLI patch versions, with a one-time cold-cache transition from version-qualified keys. Records include diagnostic writer metadata; the optional root envelope uses a numeric layout-reader protocol. Remote `prune --keep-current` preserves the current packing format. Cache writers compare the stable record identity while ignoring diagnostic writer metadata. See [CACHE_RETENTION.md](CACHE_RETENTION.md) for rollback and accounting contracts.

The bundled syntax analyzer now uses Babel instead of the TypeScript compiler API, and the development typechecker is updated to TypeScript 7.0.2. Existing macro/data-loader, Node guard and diagnostic contracts are retained. See [PARSER.md](PARSER.md) for the maintenance window and measured size/scan tradeoff. Workspace narrowed-input fingerprints move to `member-inputs-v2`; this deliberately causes a cold cache for those inputs.

## Build preparation and dependencies

- Share authenticated runtime files across targets, cancel sibling preparation when one target fails, bound process-group draining and avoid unnecessary workspace snapshots.
- Move runtime syntax analysis from the TypeScript compiler API to Babel and update the development typechecker to TypeScript 7.0.2. The measured JavaScript artifact is approximately 76% smaller; the fixed syntax-scan corpus is approximately 1.6 times slower. See [PARSER.md](PARSER.md) for the measured tradeoff and parser maintenance window.
- Update Bun type definitions to 1.4.2 and the font-validation example to Canvas 1.0.9. Host Bun support remains `>=1.3.13 <1.4 || >=1.4.2 <1.5`.

## Compatibility and migration

- Existing managed caches are retained, but the new packing/policy identities cause a one-time cold-cache transition. Narrowed workspace fingerprints also change. Keep sufficient disk space during upgrade/rollback; do not expect every layer to remain warm across releases.
- Root cache envelopes use a numeric layout-reader protocol. Unknown namespaces or future records are unmanaged and prevent blob reclamation, preserving references older readers cannot understand. Legacy or ambiguous abandoned locks still require manual recovery.
- Registry `prune --keep-current` preserves current packing/plan formats. Provider-specific retention remains an external lifecycle policy.
- Isolated 0.10.0 and 0.11.0 source CLIs passed shared local/registry cache and report upgrade/rollback acceptance. Historical rebase/base-status checks validate metadata; runtime acceptance is separate.

## Format changes

- Unsupported rebase capsule and SBOM evidence revisions now produce typed, version-oriented diagnostics. `base-status` reports future capsules as `not-rebaseable` / `unsupported-format`, including when the selected base digest is current. Known security-bearing formats retain strict validation; these diagnostics do not change capsule or evidence writer shapes.
- Released ownership/evidence fixtures and an evidence reader rollback matrix document the supported boundary: ordinary v1 evidence remains readable by 0.9/0.10; degraded v2 evidence requires 0.11 or later.

# v0.11.0

This release adds compile-mode execution arguments and hardens credential handling, repository inputs, image execution, Node compatibility, rebase acceptance and cancellation.

## Compatibility and migration

- Supported host Bun versions are `>=1.3.13 <1.4 || >=1.4.2 <1.5`, with CI and verified runtime/compile pins for 1.3.13 and 1.4.2. Upgrade Bun 1.4.0/1.4.1 to 1.4.2, or retain bunko v0.10.0.
- Explicit image users must be canonical numeric `uid[:gid]`. Replace names such as `nonroot` with `65532:65532`. Named, signed and zero-padded base users fall back to the nonroot default.
- Bun bundle images now include `--no-install`, matching source images. Undeclared computed imports cannot download dependencies during image execution.
- Project npm credential expansion requires `BUNKO_NPM_*` names or exact operator permission through `BUNKO_NPM_CREDENTIAL_ENV`. Credentials must have a declared registry host scope. Existing `${NPM_TOKEN}` configurations need an explicit grant or a renamed variable.
- Resolve/apply targets must stay inside `--context`; trusted external targets require `--allow-external-context`. Project configuration symlinks are rejected. Git dirty-state metadata is omitted when status could execute configured filters or inspect submodules.
- Build/rebase Actions require bunko >=0.10.0 and <1, fail early with a version hint, and validate report schemas. Published setup-bunko v0.1.1 remains immutable and defaults to CLI v0.8.0; select the CLI version explicitly.

## Runtime and build behavior

- Compile mode accepts a validated subset of `runtime.args` through Bun's `--compile-exec-argv`, keeping application arguments separate and incorporating execution options into cache identity.
- Node builds accept portable guarded Bun references and inspect relevant runtime inputs. Runtime major metadata is checked against the selected base where supported. Bun diagnostics retain their existing policy boundary.
- Rebase checks Docker availability before publication, reports smoke failures with platform/exit information, permits a configurable image-load deadline, exposes attestation inputs in the Action, and avoids repeated source inspection for base-status.
- Keyless signing supports projected token symlinks, ignores an empty explicit environment token when selecting providers, and removes the obsolete GitLab token fallback.
- Container examples document signal handling, nonroot execution, read-only roots and writable temporary storage.

## Security and reliability

- Registry requests suppress Bun verbose fetch diagnostics so Authorization values do not appear in CI logs. Credential refresh is separated from ordinary in-flight lookup; offline credential validation and sensitive-file exclusions still run.
- Repository-selected npm variables and configuration paths are constrained before parsing. Git metadata disables execution-capable hooks/fsmonitor and skips unsafe status inspection.
- Child-process deadlines escalate uncooperative processes, cleanup receives a bounded grace period, and packing/decoding/copy operations observe cancellation.
- Registry writes have a separate 30-minute total attempt budget, configurable programmatically. Read-header limits do not abort a still-progressing upload after local source EOF. Failed writes retain publisher reconciliation instead of unconditional retries.
- Cache diagnostics identify confirmed dead local owners, cap lock waits and report crash residue; pruning preserves foreign-format closure plans under ordinary age/budget rules. Automatic lock recovery and cache layout redesign remain follow-ups.
- Release publication selects only the exact version's notes; privileged workflows narrow write permissions, disable lifecycle scripts during installation and share a checksum-pinned cosign installer. Third-party notices match the bundled parser version.

## Format changes and limitations

Oversized SBOM build evidence degrades with explicit omission counts rather than failing the build. Its v2 form is rejected by released 0.9.0/0.10.0 readers during `rebase --sbom`; use 0.11.0 to retain that evidence. Node rebase capsules require readers from 0.9.0 onward. See the persisted-format compatibility guide for rollback boundaries.

Runtime memory sharing, automatic cache lease recovery, stable per-layer cache identities, remote retention controls and historical format interoperability fixtures remain open work. This release does not add a general OS package scanner, automatic VEX decisions or broader live cloud-provider certification.

# v0.10.0

This release adds opt-in native AWS registry authentication with `--auth-source aws`. Private ECR supports environment credentials, Web Identity token files (the STS path used by IRSA), ECS/EKS container credentials and IMDSv2. ECR Public authorization is also implemented. Docker-compatible authentication remains the default; profiles and SSO continue to use a credential helper.

Private ECR publication now accepts its HTTP 201 PATCH responses while retaining final digest completion and blob verification. The change fixes a real upload failure found during acceptance.

GitHub OIDC acceptance passed both native Web Identity → STS → ECR and temporary environment credential paths with a dedicated repository-scoped role. Checks covered credential refresh, chunked uploads, digest-verified pulls, blob reuse, CLI builds and private-base inspection. Local tests also verified immutable-tag conflict handling. Deployed EKS IRSA/Pod Identity, EC2 IMDSv2 and ECR Public remain protocol-tested rather than live-certified. See [AWS acceptance](https://github.com/sakajunquality/bunko/blob/main/docs/validation/aws-registry-credentials.md).

Bun >=1.3.13 <1.5 remains supported in this release. The independently versioned setup-bunko v0.1.1 Action still defaults to CLI v0.8.0; select `version: v0.10.0` explicitly after publication.
