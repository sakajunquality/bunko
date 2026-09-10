<p align="center">
  <img src="assets/logo.png" alt="bunko logo" width="200">
</p>

# bunko

Build OCI images from Bun projects without a Dockerfile or Docker daemon. Inspired by Go's [ko](https://ko.build/).

**v0.3.1** supports standalone apps and Bun workspaces, Bun 1.4, bundle/source/compile modes with module-location diagnostics, optional signed Bun runtime injection, npm dependencies, explicit runtime externals, Registry publication, dependency and asset caching, multiple platforms, Docker/kind loading, and YAML/JSON resolution. GHCR, Google Artifact Registry, Docker Hub, and ECR use Docker credentials. See the [Registry matrix](docs/REGISTRIES.md) for the distinction between implemented authentication and verified service interoperability.

See the [feature guide](docs/FEATURES.md), [0.3.1 release notes](docs/RELEASE_NOTES.md), and [comparison with ko and BuildKit](docs/COMPARISON.md). Review the documented compatibility and trust boundaries before adopting it.

## Install a release

Download `bunko.js`, `SHA256SUMS`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `PROVENANCE.jsonl` from the [v0.3.1 release](https://github.com/sakajunquality/bunko/releases/tag/v0.3.1) into the same directory. Install Bun 1.4.2 (or another supported version), then verify the files before running the CLI:

```sh
# Linux; on macOS use: shasum -a 256 --check SHA256SUMS
sha256sum --check SHA256SUMS
bun ./bunko.js version
bun ./bunko.js build /path/to/app --push=false --oci-layout /tmp/my-app-image
```

See [the setup Action and installation guide](docs/RELEASING.md) for CI installation and private repository authentication. Existing release assets remain immutable. The CLI is also published as [`@sakajunquality/bunko`](https://www.npmjs.com/package/@sakajunquality/bunko). Run `bunx @sakajunquality/bunko@0.3.1 version`, or install it with `npm install -g @sakajunquality/bunko@latest`. Bun must already be on PATH. See the [npm distribution guide](docs/NPM_DISTRIBUTION.md) for provenance status and version selection.

Compile mode and runtime injection additionally require `gpgv` and a pinned official Bun revision. Version 0.3.1 supports 1.3.13 and 1.4.0–1.4.2; published 0.1.4 also supports 1.3.11/1.3.12.

## Quick start from source

Version **0.3.1** requires Bun `>=1.3.13 <1.5`; CI covers Bun 1.3.13, 1.4.0 and 1.4.2. Published 0.1.4 remains available for Bun 1.3.11/1.3.12. The distributed `dist/bunko.js` bundles its YAML and TypeScript parsers and requires no external npm runtime dependencies. Install development dependencies before running from source:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run dev build examples/hello \
  --push=false --oci-layout .bunko-output/hello \
  --verify-deterministic
```

This downloads a public Bun base and writes a complete OCI layout. The destination must be absent or empty. The default platform is `linux/amd64`. Logs go to stderr; export produces no stdout.

To publish to a Registry where you have authenticated, replace `OWNER` with your namespace:

```sh
bun run dev build examples/hello --repo ghcr.io/OWNER
```

Success prints one `ghcr.io/OWNER/hello@sha256:...` line. `--bare` treats `--repo` as the exact repository. Default tags are `latest` and the Git revision; override them with `--tag v1 --tag latest`. See [authentication setup](docs/REGISTRIES.md).

rc.4 and later also support [source-preserving mode](docs/SOURCE_MODE.md), [prepared bases and offline builds](docs/OFFLINE.md), [runtime/workspace configuration](docs/CONFIGURATION.md), and [system font mappings](docs/FONTS.md). These additions are not present in the immutable rc.3 CLI or container.

## Custom bases without Bun

Opt into [signed runtime injection](docs/RUNTIME_INJECTION.md) for an explicit glibc base. This requires GnuPG's `gpgv` on the build host and does not install native-addon shared libraries:

```sh
bun ./bunko.js build /path/to/app --runtime-inject release \
  --base gcr.io/distroless/base-debian12@sha256:7f0c72cd138b442ae0deeb69c08b1acf5525439ba251a49ad93c320a061567e5 \
  --push=false --oci-layout /tmp/injected-image
```

Use a digest-pinned cc/custom base when the application needs additional libraries. Verify the composed runtime with `check-base --runtime-inject release --run`, then exercise the actual application.

## Workspaces and monorepos

Build and publish multiple services using the root `bun.lock` and `workspaces` declaration:

```sh
# Publish ghcr.io/OWNER/api and ghcr.io/OWNER/worker.
bun run dev build examples/workspace --repo ghcr.io/OWNER

# Select by package name or root-relative path; --target is repeatable.
bun run dev build examples/workspace --target @example/api --repo ghcr.io/OWNER

# A member directory also uses the workspace root lock.
bun run dev build examples/workspace/services/api --repo ghcr.io/OWNER

# Export multiple targets into one OCI layout.
bun run dev build examples/workspace --push=false \
  --oci-layout .bunko-output/workspace --platform linux/amd64,linux/arm64
```

Automatic root selection excludes `bunko.enabled:false` and prefers members with `bunko` configuration. Otherwise it selects members with `bin` or `module`. Put service configuration in each member's `package.json.bunko`; root application settings are not inherited implicitly. rc.4 and later support explicit `bunko.defaults`; see [configuration](docs/CONFIGURATION.md).

Publication starts after every selected target builds successfully. Stdout contains one digest per target in a fixed order. `--report` records partial publication failures and replaces an earlier run's report file. `--bare` and `--tarball` require a single target.

Shared packages are bundled by default. Explicitly external workspace packages retain Bun's concrete versions and peer contexts. The production strategy includes the **entire workspace production tree**, including other services' dependencies. Select only reachable runtime instances with `--deps-strategy closure` or each service's `bunko.deps.strategy: "closure"`:

```sh
bun run dev build examples/workspace --repo ghcr.io/OWNER --deps-strategy closure
# Put the union of selected services' dependencies in one shared layer.
bun run dev build examples/workspace --repo ghcr.io/OWNER --shared-deps
```

`--shared-deps` or root `bunko.sharedDeps:true` defaults to closure and shares a dependency layer across targets with matching workdir, base, and platforms. Target-specific external links live in the app layer, preserving different versions of the same package. Closure performs a Linux production install to verify the graph on every invocation. Unrelated lock or source changes can still reuse the layer when selected package bytes, modes, and links are unchanged.

Workspace declarations accept positive relative globs as an array or a `workspaces.packages` array. Default and named catalogs may be declared at the root or inside the workspaces object. Nested workspaces and file/link dependencies are unsupported. Configure npm authentication, overrides, and patches at the root.

## npm dependencies and native addons

Ordinary JavaScript dependencies are bundled. Declare packages that must remain at runtime in `package.json.bunko.external`. Projects with dependencies need a consistent text `bun.lock`. bunko performs frozen installs in temporary directories instead of using the checkout's `node_modules`. Install scripts never run.

```sh
bun run dev build examples/dependencies \
  --push=false --oci-layout .bunko-output/dependencies \
  --platform linux/amd64,linux/arm64 \
  --verify-deterministic --report .bunko-output/dependencies.json
```

This example bundles `is-number` and externalizes `@node-rs/xxhash`. Its Linux native addon has run successfully on both platforms. Native dependencies require an explicit base containing their shared libraries; the example uses `oven/bun:1.3.13-slim`. Compatibility with arbitrary native packages or base ABIs is not established.

Layer order is `base → deps (if needed) → assets (if present) → app`. The production strategy retains production dependencies and excludes dev dependencies. A source-only rebuild can avoid dependency and asset transfers. Build dependencies are still prepared for bundling on cache hits.

## Cache and local execution

The local layer cache defaults to `${XDG_CACHE_HOME:-~/.cache}/bunko/v1`. Without explicit export destinations, Registry caches use reserved tags in the publication repository. Override these with `--cache-dir` and `--cache-repo`, or disable both with `--no-cache`. Bun's package download cache is separate: it defaults to `${XDG_CACHE_HOME:-~/.cache}/bunko/install/v1`, `--install-cache` overrides it, and `--no-cache` or `--no-local-cache` uses per-build temporary staging instead. Cache read failures are diagnostic and recoverable. Export failures warn by default; `--cache-export-error=fail` makes them fatal while preserving publication evidence. Image publication failures are errors.

```sh
# Export a single-platform Docker archive.
bun run dev build examples/hello --push=false --tarball .bunko-output/hello.tar

# Load into Docker on Apple Silicon.
bun run dev build examples/dependencies --local --platform linux/arm64

# Load into an existing Docker-backed kind cluster.
bun run dev build examples/hello --kind --kind-cluster kind --platform linux/arm64
```

`--local` and `--kind` disable publication and print the loaded content tag. Ordinary build, publication, and export do not require Docker. `--dry-run --repo ...` builds and reads Registry metadata to estimate transfers without publication, export, or loading.

## Resolve YAML and JSON

Replace complete `bunko://<project-directory>` string values with published `repo@sha256:...` references. This does not apply Kubernetes resources.

```sh
bun run dev resolve -f examples/manifests/services.yaml \
  --context examples/workspace --repo ghcr.io/OWNER --shared-deps

# Stdin uses the same reference-path base.
cat examples/manifests/services.yaml | bun run dev resolve -f - \
  --context examples/workspace --repo ghcr.io/OWNER
```

Repeat `-f` for multiple inputs. Directories are read in name order for YAML/YML/JSON; use `--recursive` for nested directories. References are relative to cwd or `--context`, independently of the input file's location. Use a service directory when a workspace root selects multiple targets.

Comments, anchors, aliases, mapping keys, and references embedded in descriptive text are preserved. Each canonical target builds once. All images and the completed output are validated before publication starts. Only complete success emits resolved documents to stdout; logs use stderr. One JSON input remains JSON, multiple JSON inputs form an array, and inputs containing YAML produce a YAML document stream. `--report` can record partial publication.

Resolve publishes by default, or loads Docker/kind images with `--local`/`--kind`. It rejects standalone `--push=false`, OCI layout/tarball export, `--dry-run`, and `--target`.

## Reproducibility and limitations

`--reproducible` requires a digest-pinned base or `--base-layout`. `--verify-deterministic` bypasses layer caches and compares two independent staging builds. Use `--git-metadata=false` to omit automatic Git metadata.

See [Operations](docs/OPERATIONS.md) for prepared dependency artifacts, apply, layout publication, and cache pruning.

See [Supply-chain and compile support](docs/SUPPLY_CHAIN.md) for opt-in metadata, private signing, base checks, and Linux executable builds.

Unsupported: nested workspaces, file/link/git dependencies, bytecode, source symlinks, unsupported `bunfig.toml` settings, macros in bundle/compile mode, computed application imports in bundle/compile mode, runtime packages requiring install scripts without an explicit ignored-script allowance or prepared dependency artifact. Executable build inputs are checked before Bun parses them; copied assets and unreachable modules do not undergo executable syntax validation. See [application compatibility](docs/APPLICATION_COMPATIBILITY.md) for data imports and explicit dependency policies. Unknown or unsupported settings fail explicitly.

## Diagnostics

Use `bunko check-config PATH` for offline configuration checks and `bunko doctor PATH` for toolchain diagnostics. Both print a readable summary in a terminal and the same report as one JSON line when stdout is redirected; use `--format json` or `--format text` to choose explicitly. `bunko closure-info PATH` prints the largest packages in the dependency closure (`--top N`, default 20) and every package the closure carries under more than one version; `bunko why PACKAGE PATH` prints each instance of one package with its version, size and the dependency path that pulls it in. Both install Linux production dependencies to enumerate the closure, so they need package registry access, but they never contact an image registry and never publish; `--json` emits the same data for scripts. See [trimming a dependency closure](docs/APPLICATION_COMPATIBILITY.md#trimming-a-dependency-closure). Workspace builds support bounded `--jobs` and reusable application layers. See [compatibility and migration](docs/COMPATIBILITY.md), [performance](docs/PERFORMANCE.md), [operations](docs/OPERATIONS.md), and [supply-chain metadata](docs/SUPPLY_CHAIN.md).

## Portable ko workflows

Use `--image-label`, `--image-annotation` and `--image-user` for per-invocation image metadata, and `--image-refs FILE` for a new file of published immutable references. Resolve/apply support `--selector` label queries. A `bunkodata/` directory is included as assets and exposed through `BUNKO_DATA_PATH`. See the [comparison](docs/COMPARISON.md) for deliberate differences.

## Local manifests, metadata and cache control

Resolve directly into Docker or kind with `resolve --local` or `resolve --kind`. Use `apply --kind` with the matching kind context; ordinary `apply --local` is rejected because a Docker daemon does not identify a Kubernetes cluster. See [Local development](docs/LOCAL_DEVELOPMENT.md).

Use `--progress=json` for stage events on stderr. `.bunkoignore` excludes optional context inputs; required inputs cannot be ignored. `--cache-from` adds ordered trusted registry/local read locations, `--cache-to` selects explicit write destinations, `--cache-write=false` suppresses explicit exports and Registry cache writes, and `cache-info` / `prune --keep-bytes` provide managed local retention. See [Cache retention](docs/CACHE_RETENTION.md) for the trust boundary and explicit deletion contract.

`metadata IMAGE@DIGEST --metadata-dir DIR` exports exact SPDX/provenance payloads. `--base-sbom`, `--deps-verify-key` and the opt-in `--supply-chain-policy ci` add explicit inventory linkage and producer policy. See [Metadata](docs/METADATA.md) for partial coverage and signing requirements. Private CA/mTLS configuration and zstd base reading are supported; generated layers remain gzip.

## Development and validation

```sh
bun run check
bun run build
bun dist/bunko.js --help

# Docker and network required for publication, reuse, pull, and runtime checks.
bun run test:build-smoke
bun run test:workspace-smoke
bun run test:closure-smoke
bun run test:resolve-smoke
bun run test:bundled-smoke
```

Ordinary tests need no network or Docker and include independent Python 3 tarfile checks. CI runs typechecks, tests, and CLI bundling on Linux/macOS, plus real Registry integration on Linux. Smoke tests create and remove their own Registries, containers, and image tags. Runtime tests default to amd64 and arm64; set `BUNKO_SMOKE_PLATFORMS=linux/amd64` to restrict supported target selection. Some multi-platform publication fixtures still build both platforms.

- [Current implementation specification](docs/SPEC.md)
- [Migrating from a Dockerfile](docs/MIGRATING_FROM_DOCKERFILE.md)
- [Registry configuration and verification status](docs/REGISTRIES.md)
- [Public repository readiness review](docs/PUBLIC_READINESS.md)
- [Review follow-up and syntax-scan measurements](docs/REVIEW_FOLLOWUP.md)
- [Architecture](docs/DESIGN.md)
- [Validation records and transfer measurements](docs/VALIDATION.md)
- [Original v0.1 proposal, translated into English](docs/archive/SPEC-v0.1.md)

Release preparation and the setup-bunko GitHub Action are documented in [RELEASING.md](docs/RELEASING.md). The version tag and release must exist before using the release download path. When `version` is omitted, the Action uses a version-shaped `uses:` ref only when its Action repository matches the configured release repository; otherwise it uses the Action checkout’s `package.json` version. An explicit `version` always overrides this selection; Action tags cut before that resolution existed, including v0.1.2, still need it.

Licensed under [MIT](LICENSE). Bundled dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

See [security reporting](SECURITY.md) and the [roadmap](docs/ROADMAP.md) for support boundaries and planned work.

Named external runtime files can be mapped with `bunko.assetMappings` and repeatable `--asset-context NAME=DIR` bindings. See [application compatibility](docs/APPLICATION_COMPATIBILITY.md#named-local-asset-contexts) for exact destination and exclusion rules.

An `assetMappings` entry can also take its content from outside the project instead of a bound context. `{ "image": "ghcr.io/OWNER/tool:v1", "from": "/usr/local/bin/tool", "to": "/app/bin/tool", "mode": "0755" }` copies an exact file or directory out of another image, the way `COPY --from` does, resolving the reference per target platform and recording the resolved digest in the report and provenance; `{ "url": "https://...", "sha256": "<64 hex>", "to": "/app/bin/tool", "mode": "0755" }` fetches one file over HTTPS and verifies it against the mandatory checksum before use. Both are cached under `--asset-cache`, so a non-Bun binary such as a static Go migration tool no longer needs a CI download step. See [image and URL asset sources](docs/APPLICATION_COMPATIBILITY.md#image-and-url-asset-sources).

Build observability is available through opt-in [OpenTelemetry traces and metrics](docs/TELEMETRY.md) with `--otel`.
