# Live registry validation

2026-09-08 (Asia/Tokyo). These tests use dedicated repositories explicitly selected by the repository owner. Authentication and registry permissions are existing configuration; the tests do not change IAM or repository visibility.

## GitHub Container Registry

- Image: `ghcr.io/sakajunquality/bunko-test`.
- Cache: `ghcr.io/sakajunquality/bunko-test/cache`.
- Authentication: the private `sakajunquality/bunko-test` repository's `GITHUB_TOKEN` with `packages:write`.
- Host: GitHub Actions `ubuntu-latest` AMD64, Bun 1.3.11; ARM64 execution uses QEMU.
- Evidence: [successful workflow](https://github.com/sakajunquality/bunko-test/actions/runs/34144008149) and [conformance summary](validation/2026-09-08-ghcr.json). The workflow tests the source revision recorded in its `upstream.json` snapshot, without cross-repository credentials or a personal token.

The initial ranged PATCH returned HTTP 416. A subsequent upload-status GET timed out, then redirected to a GitHub URL that returned 404. The [diagnostic run](https://github.com/sakajunquality/bunko-test/actions/runs/34143687813) logs only method, host, endpoint category, content length, status, Range, and duration; it omits credentials, paths, signed queries, and bodies. bunko now also uses a full-file PUT for GHCR. This is an observed compatibility workaround; the test does not establish that every possible GHCR chunked-upload format is unsupported.

The corrected run passed deterministic builds, publication, separate dependency/asset cache reuse, fresh-client and direct Docker digest pulls, config-byte verification, and both platform runtime/shutdown checks. Both containers returned the expected native xxhash result, ran as `65532:65532` with a read-only root filesystem, and exited 0 on SIGTERM.

Initial layer/config payload was 139,768,462 bytes. The source-only update uploaded 10,311 bytes, with zero dependency/asset payload. The successful workflow keeps the full report as its `ghcr-conformance` artifact.

## Google Artifact Registry

- Image: `asia-northeast1-docker.pkg.dev/sakajun-public/test/bunko-conformance`.
- Cache: `asia-northeast1-docker.pkg.dev/sakajun-public/test/bunko-conformance-cache`.
- Authentication: Docker's gcloud credential helper with `CLOUDSDK_ACTIVE_CONFIG_NAME=private`.
- Host: macOS arm64, Bun 1.3.11, Docker Desktop 29.3.1. ARM64 runs natively in the Linux VM; AMD64 uses Docker Desktop's emulation.
- Evidence: [conformance summary](validation/2026-09-08-gar.json), including source revision, immutable image/config digests, tags, runtime responses, transfer records, and a hash of the full local report.

The first run failed on the second 8 MiB PATCH with HTTP 405; its upload-status GET also returned 405. A small single-PATCH probe succeeded. This matches Google's requirement to use [monolithic uploads](https://docs.cloud.google.com/artifact-registry/docs/reference/docker-api). bunko now streams the complete CAS file in PUT for Artifact Registry and reconciles the digest before restarting an interrupted upload in a fresh session. It does not load the entire layer into a JavaScript buffer. Regression tests cover files larger than one chunk, default port normalization, failures before and after commit, permanent denials, and bounded transient retries.

The corrected run passed:

- Independent deterministic builds of linux/amd64 and linux/arm64.
- Initial publication: 139,768,463 bytes of layer/config payload to the empty image repository.
- Source-only update: 10,312 bytes of layer/config payload, with zero dependency/asset upload and verified dependency/asset hits from the separate Registry cache.
- Fresh authenticated client pull and direct Docker pull by platform manifest digest, with exported config bytes independently checked.
- Both platform containers served the expected response and native xxhash result, ran as `65532:65532` with a read-only root filesystem, and exited 0 on SIGTERM.

Payload figures exclude cache-publication traffic, HTTP overhead, retries, manifests, and indexes. They are not total network traffic or comparative performance benchmarks. The test retains its remote unique image/cache tags and removes only its own local containers, images, and temporary files.

## Remaining coverage

Docker Hub account push and ECR private remain unverified. Token expiry, permission changes during a run, private npm services, referrers, signing, and other repository policy combinations require separate tests. Cache reuse from a different repository does not by itself prove that cross-repository blob mounting occurred.

## Regression validation

`bun run check` passes with 170 tests and 579 assertions on the tested source revision. The PR CI additionally checks Linux/macOS distribution installation and authenticated Distribution 3 integration.

## M6 and portable ko additions: private supply-chain validation

On 2026-09-08 JST, the owner-authorized dedicated GHCR and GAR repositories also passed `test/supply-chain-conformance.ts`:

- A deterministic amd64/arm64 image index, two SPDX inventories and one SLSA provenance artifact were published and retrieved by immutable digest.
- cosign 3.1.3 signed the index, both platform manifests and all three artifacts with disposable local keys. All six signatures per provider verified using the matching public key and private-signature mode.
- Signing explicitly disabled public transparency-log uploads. Temporary local keys/passwords were removed; unique remote test tags/signatures were retained for inspection.
- OCI annotations, CLI labels, conventional bunkodata and immutable reference-file generation participated in these builds.

GHCR used the existing packages-write GITHUB_TOKEN in the **private** bunko-test repository. Its [successful workflow](https://github.com/sakajunquality/bunko-test/actions/runs/34153165727) also reran the earlier push/cache/direct-pull/native/runtime conformance. The checksum-pinned Linux cosign binary came from the official v3.1.3 release. [GHCR supply-chain report](validation/2026-09-08-ghcr-supply-chain.json).

GAR used the existing Docker gcloud helper with the private gcloud configuration; IAM and visibility were unchanged. [GAR supply-chain report](validation/2026-09-08-gar-supply-chain.json).

This closes the earlier unverified referrer/signing item for these particular provider configurations. It does not establish every registry policy or key backend. Docker Hub account publication and ECR private remain unverified. OS/runtime checks remain separately recorded in validation/m6-runtime.json and validation/ko-runtime.json.
