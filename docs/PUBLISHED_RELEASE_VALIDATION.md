# Published alpha.2 validation

The committed validation reports are the primary reader-accessible evidence. Links to workflows in the separate private `bunko-test` repository require access and are supplemental; publishing Bunko does not publish that test repository.


On 2026-09-08, the [v0.1.0-alpha.2 prerelease](https://github.com/sakajunquality/bunko/releases/tag/v0.1.0-alpha.2) was published while the repository was private, from commit `4766373ab3369bb776433b2957a82260e72656e2`. Repository visibility and IAM were unchanged. No npm package was published.

The downloaded `bunko.js` SHA-256 is `fc6af0500637623df354ebe983004447acade1abd4117fd41b25d7b3456241e6`, identical to the reviewed candidate. Every registry build below reports this builder digest. The [machine-readable evidence](validation/published-alpha2.json) records immutable image references, transfers, runtime checks, and limitations.

## Installation

- Authenticated downloading, checksums, and version verification passed through `scripts/setup.ts` on macOS against the actual private release.
- The setup action's network download path passed on Linux in the [release repository workflow](https://github.com/sakajunquality/bunko/actions/runs/34181456366), using its standard repository token.
- The separate private `bunko-test` repository used the same downloaded release assets with `distribution-directory`. Its ordinary `GITHUB_TOKEN` cannot read another private repository's releases. No personal token was copied into Actions secrets and private action sharing was not enabled. This validates pre-downloaded installation there, not cross-repository network authentication.
- The fixture assets live only on the `validate/published-alpha2` validation branch. Its additional metadata/signing steps use older vendored source and are not evidence for the distributed CLI.

## Registry results

| Registry | Destination | Result |
| --- | --- | --- |
| GHCR | `ghcr.io/sakajunquality/bunko-test` | [CI passed](https://github.com/sakajunquality/bunko-test/actions/runs/34180981600); separate cache repository |
| Artifact Registry | `asia-northeast1-docker.pkg.dev/sakajun-public/test/bunko-conformance` | Passed locally with the existing gcloud helper and private configuration |
| Docker Hub | `docker.io/sakajunquality/test-bunko` | Passed locally with the existing Docker Desktop credential store |

Each run built both platforms, verified deterministic output, published a source-only update, verified registry dependency/asset cache reuse without reuploading those layers, independently pulled and checked digests, and directly pulled through Docker. Both amd64 and arm64 containers returned the expected native dependency result, ran as `65532:65532` with a read-only filesystem, and exited 0 on SIGTERM. Test image and cache tags are retained in the owner-selected repositories. These three initial reports used the earlier subprocess wrapper; their recorded builder digests identify the exact release bytes. The reviewed harness subsequently passed a separate Docker Hub rerun, recorded as `reviewedHarnessDockerHubRepeat` in the evidence.

## Authentication-required upstream

A public Bun base was copied into the existing GAR test repository as `private-base-alpha2-20260908`, then consumed by immutable manifest digest. Anonymous `check-base` failed with HTTP 403 and exit code 1. With the existing gcloud helper, the published CLI successfully built and ran SQLite applications in both bundle and compile modes on linux/arm64. These runtime checks used Docker archive loading and a read-only filesystem with a writable `/tmp`.

The same authenticated GAR base was used while publishing an application to `docker.io/sakajunquality/test-bunko:private-upstream-alpha2-20260908`, exercising separate upstream gcloud and downstream Docker Hub credentials. Only the deliberately mirrored public Bun base content was republished.

To repeat release conformance, supply a new report path and a dedicated repository:

```sh
BUNKO_TEST_CLI=/path/to/downloaded/bunko.js \
BUNKO_SMOKE_VENDOR=dockerhub \
BUNKO_SMOKE_REPO=registry-1.docker.io/OWNER/test-bunko \
BUNKO_SMOKE_PLATFORMS=linux/amd64,linux/arm64 \
BUNKO_SMOKE_REPORT=/tmp/new-registry-report.json \
bun test/registry-conformance.ts
```

`BUNKO_TEST_BASE` selects an upstream base for CLI conformance and the distributed-CLI runtime smoke test. Without `BUNKO_TEST_CLI`, runtime smoke still uses its normal source-build default. Private ECR, Docker Hub referrers/signatures, token expiry, permission changes, and other private upstream authentication policies remain separate tests.

## Review and harness checks

Claude review identified lost partial-publication details in subprocess failures, ambiguous PATH-based setup verification, and missing invocation fingerprints. The harness now preserves partial publication, records and checks the downloaded CLI digest, streams build diagnostics without copying them into its summary error, and has a subprocess failure-report regression. The workflow invokes the exact setup output path and accepts an optional explicit published version. Docker Hub conformance passed again after these changes.
