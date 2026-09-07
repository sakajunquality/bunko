# bunko

Build OCI images from Bun projects without a Dockerfile or Docker daemon. Inspired by Go's [ko](https://ko.build/).

**v0.1.0-alpha.1 / M2 preview** supports standalone apps and Bun workspaces, bundling, npm dependencies, explicit runtime externals, Registry publication, dependency and asset caching, multiple platforms, Docker/kind loading, and YAML/JSON resolution. GHCR, Google Artifact Registry, Docker Hub, and ECR use Docker credentials. See the [Registry matrix](docs/REGISTRIES.md) for the distinction between implemented authentication and verified service interoperability.

## Quick start

Requires Bun `>=1.3.11 <1.4`; validation uses Bun 1.3.11. The distributed `dist/bunko.js` bundles its YAML parser and requires no external npm runtime dependencies. Install development dependencies before running from source:

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

Automatic root selection excludes `bunko.enabled:false` and prefers members with `bunko` configuration. Otherwise it selects members with `bin` or `module`. Put service configuration in each member's `package.json.bunko`; root application settings are not inherited.

Publication starts after every selected target builds successfully. Stdout contains one digest per target in a fixed order. `--report` records partial publication failures. `--bare` and `--tarball` require a single target.

Shared packages are bundled by default. Explicitly external workspace packages retain Bun's concrete versions and peer contexts. The production strategy includes the **entire workspace production tree**, including other services' dependencies. Select only reachable runtime instances with `--deps-strategy closure` or each service's `bunko.deps.strategy: "closure"`:

```sh
bun run dev build examples/workspace --repo ghcr.io/OWNER --deps-strategy closure
# Put the union of selected services' dependencies in one shared layer.
bun run dev build examples/workspace --repo ghcr.io/OWNER --shared-deps
```

`--shared-deps` or root `bunko.sharedDeps:true` defaults to closure and shares a dependency layer across targets with matching workdir, base, and platforms. Target-specific external links live in the app layer, preserving different versions of the same package. Closure performs a Linux production install to verify the graph on every invocation. Unrelated lock or source changes can still reuse the layer when selected package bytes, modes, and links are unchanged.

Workspace declarations must be arrays of positive relative globs. Nested workspaces, catalogs, and file/link dependencies are unsupported. Configure npm authentication, overrides, and patches at the root.

## npm dependencies and native addons

Ordinary JavaScript dependencies are bundled. Declare packages that must remain at runtime in `package.json.bunko.external`. Projects with dependencies need a consistent text `bun.lock`. bunko performs frozen installs in temporary directories instead of using the checkout's `node_modules`. Install scripts never run.

```sh
bun run dev build examples/dependencies \
  --push=false --oci-layout .bunko-output/dependencies \
  --platform linux/amd64,linux/arm64 \
  --verify-deterministic --report .bunko-output/dependencies.json
```

This example bundles `is-number` and externalizes `@node-rs/xxhash`. Its Linux native addon has run successfully on both platforms. Native dependencies require an explicit base containing their shared libraries; the example uses `oven/bun:1.3.11-slim`. Compatibility with arbitrary native packages or base ABIs is not established.

Layer order is `base → deps (if needed) → assets (if present) → app`. The production strategy retains production dependencies and excludes dev dependencies. A source-only rebuild can avoid dependency and asset transfers. Build dependencies are still prepared for bundling on cache hits.

## Cache and local execution

The local layer cache defaults to `${XDG_CACHE_HOME:-~/.cache}/bunko/v1`. Registry caches use reserved tags in the publication repository. Override these with `--cache-dir` and `--cache-repo`, or disable both with `--no-cache`. Bun's package download cache is separate. Cache access failures are diagnostic and recoverable; image publication failures are errors.

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

Resolve requires Registry publication. It rejects `--push=false`, export/local/kind options, `--dry-run`, and `--target`.

## Reproducibility and limitations

`--reproducible` requires a digest-pinned base or `--base-layout`. `--verify-deterministic` bypasses layer caches and compares two independent staging builds. Use `--git-metadata=false` to omit automatic Git metadata.

See [M3 supply-chain and compile support](docs/SUPPLY_CHAIN.md) for opt-in metadata, private signing, base checks, and Linux executable builds.

Unsupported: nested workspaces, catalogs, file/link/git dependencies, bytecode, source symlinks, project `bunfig.toml`, import attributes/macros, computed application imports, runtime packages requiring install scripts, apply, and cache pruning. Import attributes and macros are checked with a syntax parser. Computed-import detection remains conservative. Unknown or unsupported settings fail explicitly.

## Development and validation

```sh
bun run check
bun run build
bun dist/bunko.js --help

# Docker and network required for publication, reuse, pull, and runtime checks.
bun run test:m1-smoke
bun run test:m2a-smoke
bun run test:m2b-smoke
bun run test:m2c-smoke
bun run test:bundled-smoke
```

Ordinary tests need no network or Docker and include independent Python 3 tarfile checks. CI runs typechecks, tests, and CLI bundling on Linux/macOS, plus real Registry integration on Linux. Smoke tests create and remove their own Registries, containers, and image tags. Runtime defaults to amd64 and arm64; set `BUNKO_SMOKE_PLATFORMS=linux/amd64` to restrict execution while retaining both build platforms.

- [Current implementation specification](docs/SPEC.md)
- [Registry configuration and verification status](docs/REGISTRIES.md)
- [Public repository readiness review](docs/PUBLIC_READINESS.md)
- [Review follow-up and syntax-scan measurements](docs/REVIEW_FOLLOWUP.md)
- [Detailed design and roadmap](docs/DESIGN.md)
- [Validation records and transfer measurements](docs/VALIDATION.md)
- [Original v0.1 proposal, translated into English](docs/archive/SPEC-v0.1.md)

Release preparation and the setup-bunko GitHub Action are documented in [RELEASING.md](docs/RELEASING.md). The version tag and release must exist before using the release download path.

Licensed under [MIT](LICENSE). Bundled dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
