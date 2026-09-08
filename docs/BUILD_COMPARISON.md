# Builder comparison

Measured on macOS arm64 with Bun 1.3.11, BuildKit v0.33.0, linux/arm64 bundle output, a dedicated local Distribution registry and digest-pinned Bun bases. Each scenario has three repetitions; builder order alternates. The Bunko CLI was bundled once before measurement and its SHA-256 is recorded in the raw report.

| Scenario | Bunko median (ms) | BuildKit median (ms) |
| --- | ---: | ---: |
| cold | 5646 | 7708 |
| warm | 2091 | 913 |
| fresh-runner-remote-warm | 2026 | 1977 |
| app-edit | 2451 | 4552 |
| unrelated-edit | 2156 | 1140 |
| asset-edit | 2310 | 1319 |
| dependency-edit | 2265 | 1582 |
| base-edit | 7413 | 5497 |

These exploratory results were collected on a shared workstation alongside other verification tasks and do not establish a general speed ranking. The fixture bundles one small npm package; its npm import triggers conservative whole-context caching. Changed assets and unrelated source therefore still cause extra preparation. The cold case clears the dedicated worker cache, uses a new cache/image repository namespace and removes the selected Bun package cache. Host page caches, public upstream caches and setup-time package-manager caches are not flushed. Base changes switch between pinned slim and distroless images of the same Bun release.

The report records client CPU/RSS only; BuildKit executes work in a separate worker, so those resource figures cannot compare total builder consumption. Bunko transfer counters cover payloads, not total wire traffic or metadata; no cross-tool network-volume claim is made. Image metadata and layer boundaries differ, and the Dockerfile itself remains a tuning choice.

Run `bun test/buildkit-benchmark.ts OUTPUT.json` for the same fixture. It creates and removes only its own builder/registry. The reusable `scripts/compare-builders.ts` runner accepts explicit argv-based scenario matrices for other workloads. [Raw measurements](validation/builder-comparison.json) include ranges, client counters, versions and limitations.

Operational priority from this fixture: improve cache diagnostics and reuse across CI cache sources before adding more worker concurrency. Keep conservative input validation and do not remove base compatibility from cache identity merely to improve a benchmark.
