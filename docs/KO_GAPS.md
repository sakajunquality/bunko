# ko comparison and implementation plan

Research baseline: ko v0.19.1, commit `e388f65a1f036f19703b8aff13e1aa5521bc6988`, released 2026-06-29; GitHub reported it as the latest stable release at inspection on 2026-09-08 JST. Official docs and the release-tag source were read. This is a feature/contract comparison, not a performance or security equivalence claim. [Release](https://github.com/ko-build/ko/releases/tag/v0.19.1).

## Applicable gaps to close in this increment

| Gap at M6 | Planned Bunko behavior | Verification |
| --- | --- | --- |
| CLI image labels/user and OCI annotations | Repeated `--image-label KEY=VALUE`, `--image-annotation KEY=VALUE`, `--image-user`; config annotations; strict validation and CLI precedence | Config/manifest/index assertions, reserved keys and deterministic builds |
| Published reference list file | `--image-refs FILE` for build/resolve/apply, written only after successful publication/resolution; preflight output conflicts | Immutable refs, no clobber, no file on partial failure |
| Kubernetes document selection | `--selector` with equality/inequality requirements for resolve/apply; only matched documents build and appear in output | No-match empty output/no registry access, malformed selector before build, matching stream preservation |
| Conventional static data | Include a real project `bunkodata/` directory and expose its runtime path as `BUNKO_DATA_PATH` | Nested data, cache/source invalidation, collisions, symlink policy and runtime |

These address portable capabilities exposed by ko's [build CLI](https://ko.build/reference/ko_build/), [resolve CLI](https://ko.build/reference/ko_resolve/) and [static asset convention](https://ko.build/features/static-assets/). Bunko keeps its existing defaults unless an additive option/convention is explicitly used.

## Existing equivalents and deliberate differences

| ko capability | Bunko status after M6 / decision |
| --- | --- |
| Daemonless build/push, OCI layout, Docker archive/local/kind | Implemented; Docker is optional for exports/push and required for runtime/local checks |
| Work selection and configurable base/build settings | `package.json` + Bun workspace targets and explicit CLI/env overrides; no duplicate `.ko.yaml` or Go templates |
| Image naming variants | Package/imageName naming plus `--bare`; explicit collision errors. Go import-path/MD5 naming is not copied because Bun package identity has different semantics |
| Multiple platforms / `all` | Explicit Linux amd64/arm64; no claim to support every architecture/OS in an arbitrary base index |
| Build cache and bounded jobs | Implemented with verified application/deps/assets caches and an all-target preparation gate |
| SPDX SBOM | Implemented as opt-in OCI subject artifacts; ko enables SPDX by default. Scope excludes base OS packages and undeclared runtime packages |
| Kubernetes resolve/apply | Implemented; source-preserving URI substitution and explicit partial reports |
| `--tag-only` | Intentionally retain immutable digest references; callers can retag/copy images explicitly |
| Login | Docker credential helpers/config are consumed; use Docker/cloud CLIs to log in, without another credential-writing command |
| create/delete/run kubectl wrappers | `apply` is the supported mutation entry point. Other Kubernetes lifecycle operations remain kubectl workflows |
| Go build flags/ldflags, Delve, cgo | Language-specific; Bun equivalents are explicit build defines/minify, compile, dependency artifacts and native ELF validation |
| Ambient build env/templates | Explicit isolated build environment is retained; runtime env/config and defines are intentional inputs |
| Remote manifest URLs | Local file/directory/stdin inputs retained. Download with an authenticated external client, then resolve; implicit remote trust/credentials are not introduced |
| Terraform/Lambda integration | Deployment ecosystem integrations are separate adapters, not a requirement for portable image construction |
| Registry provider support | Distribution plus GHCR/GAR live evidence exists; Docker Hub/ECR account-specific conformance still needs suitable test credentials/destinations |

Source details: [configuration/naming/environment](https://ko.build/configuration/), [platform selection](https://ko.build/features/multi-platform/), [SBOM defaults](https://ko.build/features/sboms/), [language and OS-package limits](https://ko.build/advanced/limitations/). Bunko does not claim byte-for-byte, flag-for-flag, or ecosystem parity with ko.

## Acceptance gates

- Implement the four portable gaps above without weakening prepublication validation or immutable output.
- Run regression tests and real runtime/export checks; add Claude read-only review and fix actionable findings.
- Keep all source/docs English and repository/private signing visibility unchanged.
- Record remaining deliberate differences and external credential limits explicitly; do not mark them as tested parity.

## Implemented interface

```sh
bunko build ./service --repo REGISTRY/PREFIX \
  --image-label example.com/team=payments \
  --image-annotation org.opencontainers.image.description='Payments service' \
  --image-user 65532:65532 --image-refs ./published.txt

bunko resolve -f ./manifests --repo REGISTRY/PREFIX \
  --selector 'app=api,tier in (backend,worker),!disabled' \
  --image-refs ./resolved-images.txt
```

Repeated metadata flags use the last value for a key and override `bunko.labels`, `bunko.annotations` or `bunko.user`. Split on the first equals sign; commas remain part of a value. Annotations belong to the OCI platform manifests and runnable index; labels belong to image configuration. Bunko-reserved keys and the layout reference-name annotation cannot be overridden.

Reference files contain unique immutable registry references in result order, one per line, and require a new destination. Preflight rejects overlapping output paths. A partial build/publication creates no success reference file; use the JSON report for partial roots/tags. Resolve writes the list after every selected image publishes. Apply uses that same publication list, so it may exist even if subsequent kubectl apply fails. Files are committed without overwriting existing paths; multiple output files are not a filesystem transaction.

Selectors support `=`, `==`, `!=`, key existence, `!key`, and nonempty `in (...)` / `notin (...)` sets; comma-separated requirements are ANDed. Missing keys satisfy inequality/notin. Filtering validates YAML syntax for every input and label-map types, but resolves/builds only selected documents. No match yields empty output and no registry access; apply skips kubectl. With a selector, YAML formatting is normalized through its AST while aliases, schema versions and large integer values are retained. Without a selector, existing source-preserving replacement is unchanged. Kubernetes `List.items` are not flattened: selection applies to the document's own `metadata.labels`.

A real `bunkodata/` directory beside the target package.json is automatically included as assets under the configured workdir. `BUNKO_DATA_PATH` points to that location; conflicting runtime overrides are rejected. The normal source exclusion/symlink rules apply, including rejection of source symlinks. Explicit assets remain supported and overlapping selections deduplicate. There is no following of arbitrary external asset symlinks.
