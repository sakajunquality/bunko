# Live registry validation

2026-09-08 (Asia/Tokyo). These tests use dedicated repositories explicitly selected by the repository owner. Authentication and registry permissions are existing configuration; the tests do not change IAM or repository visibility.

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

GHCR is undergoing live validation. Docker Hub account push and ECR private remain unverified. Token expiry, permission changes during a run, private npm services, referrers, signing, and other repository policy combinations require separate tests. Cache reuse from a different repository does not by itself prove that cross-repository blob mounting occurred.
