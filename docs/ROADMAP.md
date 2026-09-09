# Roadmap

This is a delivery plan, not a promise of release dates or complete ko/BuildKit compatibility. Each implementation change receives review, and release claims identify the exact tested artifact. The [comparison](COMPARISON.md) explains the current scope. The [September recheck disposition](RECHECK.md) records repaired issues, retained contracts and the next implementation order. npm distribution starts after the next RC; musl and rebase remain tracked in issues #53 and #54.

## Release candidate and workload acceptance

- v0.1.0-rc.2 is published with reviewed diagnostics/runtime injection; its anonymous installation and CLI checksum were verified. Preserve its immutable assets.
- v0.1.0-rc.3 is published with OpenTelemetry support, verified compile runtime selection and exact-artifact validation; preserve its immutable assets.
- rc.4 is published with anonymously verified exact-candidate bytes and release-tag attestations. It adds Bun 1.4 and lockfile v2 support, the completed features below, and signed release-tag provenance. Exact candidate evidence is recorded in [rc.4 validation](validation/rc4.md).
- Anonymous installation and checksums of rc.3 were verified. The official amd64/arm64 CLI container was also published and anonymously executed.
- Complete the [remote application acceptance matrix](validation-request.html) on the application machine. Generic fixture passes do not certify Temporal, Snowflake, bot or framework-specific behavior.
- Re-run the registry matrix with the exact RC artifact before carrying forward alpha.2 interoperability claims. Record unavailable credentials or services as not-run.
- Promote to a stable release only after applicable workload checks and migration/rollback instructions have an explicit disposition.

Completion means a reader can install the candidate and distinguish verified behavior from remaining workload/provider checks. Runtime injection now has an opt-in implementation and separate ABI/runtime validation; source-preserving mode is included in rc.4.

## Real workload and registry stability

- Exercise released artifacts with standalone services, workspaces, and native/prepared dependencies.
- Add private ECR conformance when a dedicated repository and identity are available. Cover upstream reads, downstream publication, cache reuse, and both target architectures.
- Extend authenticated upstream coverage beyond the existing GAR arm64 bundle/compile tests. Test separate read and write credentials.
- Add repeatable timeout, interrupted-upload, and token-refresh scenarios. Keep cloud tests scoped to dedicated destinations.

Completion means failures have reproducible fixtures and provider claims match the tested credentials, platforms, and policies. Missing ECR infrastructure does not block independent fixes.

## Release integrity and maintenance

- Derive version/hash-specific release metadata from prepared assets, avoiding stale evidence copied from an earlier version.
- Protect published tags and verify artifact provenance from a separate consumer job, in addition to checksums.
- Automate reviewed dependency and action updates, with runtime checks before changing supported Bun versions.

Completion means a consumer can identify the artifact's origin, and automation cannot silently replace published versions or skip required checks.

## Performance and stable-release readiness

- Measure cold, warm, source-edit, and large-workspace builds using frozen toolchains. Record variance and distinguish client resource measurements from total worker or wire costs.
- Optimize bounded file processing, install/bundle overlap, transfer concurrency, or cache behavior only where profiles show a material bottleneck.
- Stabilize CLI, configuration, report formats, cache migration, and recovery instructions before a stable release. Exercise installation, upgrade, and rollback from a fresh consumer environment.

General Dockerfile/LLB execution, arbitrary RUN steps, remote workers, and broad platform expansion remain outside this plan. Rebase work first requires explicit Bun/libc/native compatibility gates.

## Completed implementation sequence

The following ordered work is implemented. Focused documentation records fixture coverage and limitations; rc.4 includes the additions after rc.3:

1. Compile correctness and verified runtime selection, followed by rc.3 preparation and exact published-artifact validation. Reject unsupported emitted assets until compilation can preserve their runtime behavior.
2. Release attestations with consumer verification; a build GitHub Action and CI guide; an official multiarchitecture nonroot CLI container and container-based CI examples.
3. Invocation-level defines; consistent proxy and npm CA handling; pull-only registry mirrors with origin-scoped authentication; persistent base preparation and bounded offline operation.
4. Source-preserving application packaging; runtime arguments, asset exclusions and modes, extra CA configuration, workspace defaults and toolchain declarations.

Source-preserving mode precedes rebase. Rebase requires a separate image compatibility and configuration ownership design. Release claims must distinguish fixture coverage from external workload acceptance and unavailable provider credentials. Review comments and all shipped documentation remain in English.

[System font packaging (#37)](FONTS.md) is also included in rc.4, with a narrow data-only destination policy, asset collision/mode checks, and renderer-specific discovery guidance. Canvas CJK/color emoji and Resvg CJK passed on both Linux architectures. General OS package-manager execution remains outside the request.
