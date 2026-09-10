# v0.2.0

The CLI process itself must run on a supported Bun version, including for diagnostics and `version`. `--bun-path` selects the build toolchain; it does not replace the Bun interpreter running the CLI.

Bunko now requires stable Bun >=1.3.13 <1.5. Bun 1.3.11 and 1.3.12 are no longer supported for running the CLI, selected build toolchains, or verified compile/injection runtimes. Upgrade Bun and update any exact `packageManager` or `bunko.toolchain.version` pins. Users who need the older toolchains can pin `@sakajunquality/bunko@0.1.4` or the v0.1.4 setup Action. Published 0.1.4 assets remain unchanged.

CI covers Bun 1.3.13, 1.4.0 and 1.4.2 on Linux and macOS; release preparation uses 1.3.13. Verified runtime pins cover 1.3.13 and 1.4.0–1.4.2. Bun 1.5 and prereleases remain outside the supported range.

See the [0.2.0 validation record](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.2.0.md). External application-machine acceptance and private ECR remain unverified; this release does not certify those workloads.
