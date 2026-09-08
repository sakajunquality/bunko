# Roadmap

This is a delivery plan, not a promise of release dates or complete ko/BuildKit compatibility. Each implementation change receives review, and release claims identify the exact tested artifact. The [comparison](COMPARISON.md) explains the current scope.

## Release candidate and workload acceptance

- Publish v0.1.0-rc.1 after reviewed changes and CI pass; preserve the immutable alpha.2 assets.
- Verify checksums and installation of the exact published RC from a clean consumer environment.
- Complete the [remote application acceptance matrix](validation-request.html) on the application machine. Generic fixture passes do not certify Temporal, Snowflake, bot or framework-specific behavior.
- Re-run the registry matrix with the exact RC artifact before carrying forward alpha.2 interoperability claims. Record unavailable credentials or services as not-run.
- Promote to a stable release only after applicable workload checks and migration/rollback instructions have an explicit disposition.

Completion means a reader can install the candidate and distinguish verified behavior from remaining workload/provider checks. Runtime injection and source-preserving mode require separate design and ABI validation.

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
