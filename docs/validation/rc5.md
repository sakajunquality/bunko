# rc.5 validation

Status: published CLI and official container consumer acceptance passed. Private GHCR application conformance remains pending because of the GitHub billing restriction described below.

Candidate version: `0.1.0-rc.5`, prepared with Bun 1.3.11. The JavaScript CLI is 7,863,758 bytes with SHA256 `56e4c2ef57ebdb1b2ac0f0c4c6e7ccee6383c9df8a86643ae9b520eae1427d83`. Every candidate result below used these exact CLI bytes. Publication and independent release/container consumer verification are separate steps; this record initially describes the prepared candidate.

## Automated and runtime checks

Typecheck and all 521 tests passed (6,207 assertions) before the validation-harness-only extension for selecting an exact CLI in the live supply-chain test. The extended harness passed typecheck and the live GAR run below. The final PR and tag workflows repeat the complete matrix.

Host Bun for real execution: 1.4.2, revision `744846f84`. Target platforms: Linux amd64 and arm64, unless otherwise stated.

| Check | Result |
| --- | --- |
| Compile and independent deterministic recompilation | Both architectures passed; complete authenticated runtime revision checked |
| Compiled application CA trust | Both architectures passed private loopback TLS in nonroot, read-only containers without external networking |
| Runtime injection | Both architectures passed; local OCI input, signed runtime/cache checks, static-base rejection and native-library boundaries passed |
| Bundle application | Both architectures passed migration, worker, PostgreSQL, HTTP/static/native modules, clean shutdown and artifact privacy checks |
| Source application | The same application checks passed on both architectures |
| Fonts | All eight positive and eight negative controls passed across bundle/source, both architectures and fontconfig/explicit-directory discovery |
| OpenTelemetry | Collector 0.120.0 received both distributed-CLI traces and metrics |

First select Bun 1.3.11 in PATH and run `bun run release:prepare`. Then select Bun 1.4.2 in PATH to execute the already-prepared candidate with the commands below. The release workflow also prepares its asset with Bun 1.3.11; the Action/container runtime selection is a separate input.

```sh
cp dist/release/bunko.js dist/bunko.js
BUNKO_CLI=dist/release/bunko.js bun test/compile-smoke.ts
BUNKO_CLI=dist/release/bunko.js bun test/runtime-ca-compile-smoke.ts
bun scripts/validation/runtime-smoke.ts
BUNKO_SMOKE_INJECT=1 bun scripts/validation/run-fixture.ts
BUNKO_SMOKE_INJECT=1 BUNKO_SMOKE_MODE=source bun scripts/validation/run-fixture.ts
bun scripts/validation/fonts-smoke.ts
bun scripts/validation/telemetry-smoke.ts
```

These are synthetic fixtures. They do not certify the separate application-machine acceptance matrix or arbitrary native packages and bases.

## Live registry and upstream evidence

- [GAR conformance](rc5-gar.json) and [Docker Hub conformance](rc5-dockerhub.json) passed deterministic publication, source-only updates, registry cache reuse with no repeated dependency/asset upload, independent verified pulls, direct Docker pulls and native nonroot/read-only execution on both architectures. Reports record the exact CLI fingerprint above, using the `sha256:` prefix in their invocation and builder digest fields. Unique test image/cache tags remain in the owner-selected dedicated repositories.
- [GAR supply-chain validation](rc5-gar-supply-chain.json) used the exact CLI to publish a multiarchitecture root, two SPDX documents and one provenance document. Independent metadata discovery and all six private signatures passed with cosign 3.1.3; no transparency-log upload was requested.
- [Authenticated upstream validation](rc5-private-upstream.json) confirmed anonymous denial and authenticated access to the existing private GAR mirror of public Bun content. Both bundle and compile SQLite applications ran on linux/arm64 with read-only filesystems. The bundle also published to Docker Hub using separate downstream credentials. No proprietary base content was copied or published.

GAR used the existing gcloud credential helper with the private configuration; Docker Hub used the existing Docker credential store. No IAM or visibility settings changed. Reports were checked for host paths, private-key PEM, bearer credentials and GitHub token patterns before inclusion.

The dedicated private GHCR validation repository was updated to the published CLI and its immutable validation harness. [Run 34308299080](https://github.com/sakajunquality/bunko-test/actions/runs/34308299080) was rejected before any steps started because GitHub reported an account payment/spending-limit restriction. GHCR application publication, cache and signature conformance for rc.5 remain pending an owner billing resolution and rerun; no result is claimed. Local GHCR push credentials are unavailable. Private ECR, token-expiry/IAM mutation scenarios and additional provider-specific immutable-tag policies remain unverified. Implemented generic recovery fixtures are not claims of every cloud policy combination.

## Publication acceptance

Before marking the RC complete, independently download the public CLI, compare it with the candidate hash above, verify signed provenance against the exact release tag and source commit, and execute it. The container workflow must build once, validate/attest the exact index and promote those bytes; verify its published digest and both architectures independently. Keep rc.4 assets and tags immutable. Setup defaults are updated only after the new release is verified.

## Published CLI verification

[Release workflow 34307997883](https://github.com/sakajunquality/bunko/actions/runs/34307997883) published rc.5 from `caca067151d2d4e0d18397dcf5846a0b09dc7fd8` on 2026-09-09. All four jobs succeeded, including the separate provenance consumer and container dispatch. The tag CI matrix also passed.

An independent setup with Bun 1.4.2 downloaded the public assets without a download token, verified every payload attestation against `refs/tags/v0.1.0-rc.5` and the exact source commit, and executed the installed CLI version. Its bytes exactly matched the candidate size/hash above. Verification against `refs/heads/main` was rejected. [Published CLI evidence](rc5-published-cli.json) records these results.

## Published container verification

[Container workflow 34308988320](https://github.com/sakajunquality/bunko/actions/runs/34308988320) passed both compiled-application smoke tests, attested the index and promoted it without rebuilding. Its recipe source is `refs/heads/main` at `aebb1697329c02170631fb4c538a8b276feb5769`; the CLI release source remains the separate commit above. The first publication attempt stopped before promotion because classic Docker could not retain both platforms under one index digest; [#70](https://github.com/sakajunquality/bunko/pull/70) releases the validated local reference between pulls. No existing version tag was replaced.

[Independent container evidence](rc5-published-container.json) records exact-source provenance verification and anonymous pulls for index `sha256:ce1cb4515ae18c52b219f3d39b2e8b32783dce66f680b90c3ec7d1a03fd22e30`. Both amd64 and arm64 returned the expected version with default UID/GID 65532, read-only filesystems, no networking and dropped capabilities. The CLI SHA256 inside each image matches the published JavaScript. CLI/container consumer acceptance passed; the separate private GHCR application conformance run remains blocked as described above.
