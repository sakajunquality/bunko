# Rebase validation

Validated on 2026-09-13 using Bun 1.4.2 and Docker 29.3.1 on macOS arm64, with amd64 execution through Docker emulation. GitHub Actions also runs the runtime matrix on native amd64 and arm64 Ubuntu runners.

The runtime matrix below tested implementation commit `6d2c33660a594f66072beefa4446881123c2b051` using bundled CLI SHA-256 `f01f8e4071b5a792bd01d3b64b5c8066402830bedc2942cfbc8ffa74fafcf141`. Each case built a public synthetic application, removed its source directory, rebased through a digest-bound ABI contract, verified unchanged generated layer digests, exported/loaded the OCI result and executed it as nonroot with a read-only filesystem and private CA HTTPS trust.

The replacement was a controlled base extension with an additional regular data file. This validates the contract mechanism and runtime preservation; it does not certify an arbitrary upstream OS update or a native addon ABI transition. Musl bundle/source cases use an injected signed Bun runtime; compile cases preserve the embedded runtime.

| libc | Platform | Mode | UID | HTTPS result | Result |
| --- | --- | --- | --- | --- | --- |
| glibc | linux/amd64 | bundle | 65532 | trusted | passed |
| glibc | linux/amd64 | source | 65532 | trusted | passed |
| glibc | linux/amd64 | compile | 65532 | trusted | passed |
| glibc | linux/arm64 | bundle | 65532 | trusted | passed |
| glibc | linux/arm64 | source | 65532 | trusted | passed |
| glibc | linux/arm64 | compile | 65532 | trusted | passed |
| musl | linux/amd64 | bundle | 65532 | trusted | passed |
| musl | linux/amd64 | source | 65532 | trusted | passed |
| musl | linux/amd64 | compile | 65532 | trusted | passed |
| musl | linux/arm64 | bundle | 65532 | trusted | passed |
| musl | linux/arm64 | source | 65532 | trusted | passed |
| musl | linux/arm64 | compile | 65532 | trusted | passed |

Pinned base indexes:

- glibc: `oven/bun@sha256:1a0c31c7c5f9d193aedf60fe1cebdeb76ac8f6e29f24be8dd8cbd6df72df26ec`
- musl: `oven/bun@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f`

A separate local Distribution test publishes through a real local OCI registry, creates fresh SBOM/provenance subjects, signs the new root, platform manifest and two attestations using cosign 3.1.3, and cryptographically verifies all four subjects with the disposable public key. Its synthetic binary fixtures test publication and signatures; executable coverage comes from the matrix above. New live GHCR, Artifact Registry, Docker Hub and ECR rebase publication was not repeated; rebase uses the existing registry implementation and mocked authenticated/immutable-tag tests.

Local regression checks cover source removal and process-execution spies, repeated rebases, equal-valued explicit settings, history and variant handling, malformed metadata, missing runtimes/libraries, whiteouts, changed file/link parents, native ABI rejection, all-platform preflight, dry-run, authenticated input and immutable tag behavior. The full Bun 1.3.13 check passed 855 tests with two intentional skips before final additions; the final changed-path run passed 43 tests. The subsequent unchanged-base subject regression is covered by the command/core suite and PR CI.

Claude Fable review was attempted but its usage-credit limit prevented execution. It is not counted as a completed review. CodeRabbit review and CI results are tracked on [PR #163](https://github.com/sakajunquality/bunko/pull/163).

Reproduce with `bun run build && bun run test:rebase` and `BUNKO_COSIGN_PATH=/path/to/cosign bun run test:rebase-registry`. See [the eligibility and trust contract](../REBASE.md) before applying this to an application.
