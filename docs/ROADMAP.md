# Roadmap

This is a delivery plan, not a promise of release dates or complete ko/BuildKit compatibility. Each implementation change receives review, and release claims identify the exact tested artifact. The [comparison](COMPARISON.md) explains the current scope.

## Public launch and the next alpha

- Finish release-first installation instructions, reader-accessible evidence, security reporting, and public contribution settings. At the visibility transition, enable GitHub private vulnerability reporting and verify the reporting form, outside-contributor workflow approval, main/tag protection, secret scanning, and push protection.
- Preserve published alpha.2 assets. Its help text predates the public launch; updated wording belongs in the next release.
- Verify a fresh installation without preexisting repository credentials and the setup Action from a separate consumer repository.
- Prepare alpha.3 only after its exact artifact passes checksums, both-platform runtime tests, and the existing registry matrix.

Completion means a new reader can install the documented release and inspect the primary evidence, with reporting and repository protections verified.

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

## Performance and beta readiness

- Measure cold, warm, source-edit, and large-workspace builds using frozen toolchains. Record variance and distinguish client resource measurements from total worker or wire costs.
- Optimize bounded file processing, install/bundle overlap, transfer concurrency, or cache behavior only where profiles show a material bottleneck.
- Stabilize CLI, configuration, report formats, cache migration, and recovery instructions before beta. Exercise installation, upgrade, and rollback from a fresh consumer environment.

General Dockerfile/LLB execution, arbitrary RUN steps, remote workers, and broad platform expansion remain outside this plan. Rebase work first requires explicit Bun/libc/native compatibility gates.
