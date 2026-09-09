# Bunko implementation specification

2026-09-08. This document describes the implemented contract. See [DESIGN.md](DESIGN.md) for future design, [the archived v0.1 proposal](archive/SPEC-v0.1.md) for the original concept, and [VALIDATION.md](VALIDATION.md) for measurements and unverified behavior.

## 1. Scope

Bundle standalone and workspace Bun applications, compose them with base images, and publish to OCI Registries, export complete OCI layouts or Docker archives, or load into Docker/kind. Supported Bun range: `>=1.3.11 <1.5`; validation baseline: 1.3.11. The distributed `dist/bunko.js` has no external npm runtime dependencies. Its pinned parsers, `yaml` 2.9.0 and TypeScript 5.9.3, are bundled with their licenses.

A build can target `linux/amd64` and `linux/arm64` together. An omitted arm64 variant means v8. Platforms have a stable index order. Building never executes target binaries or emulators. Docker archives, local/kind loading, and `--no-index` require one platform.

Supported dependencies are registry npm packages, constrained workspace references, and explicit production runtime externals. Opt-in SBOM/provenance, private key signing, base checks, and constrained Linux compile mode are implemented; see [SUPPLY_CHAIN.md](SUPPLY_CHAIN.md). Bunko provides explicit apply, prepared dependency artifacts, layout publication, and preview-first pruning; see [OPERATIONS.md](OPERATIONS.md). Bytecode remains unsupported.

## 2. CLI and results

```sh
bunko build [path] --repo <registry/prefix> [options]
bunko build [path] --push=false --oci-layout <directory>
bunko build [path] --local
bunko version
```

| Option | Behavior |
| --- | --- |
| path | Defaults to `.`; accepts `bunko://<path>`. Workspaces may select multiple targets (§8). |
| `--target NAME/PATH` | Select workspace members from the root; repeatable. |
| `--repo PREFIX` / `--bare` | Default destination is PREFIX/project-name; bare uses the exact repository. |
| `--tag TAG` | Repeatable; defaults to latest and Git revision, with a dirty suffix when appropriate. |
| `--push=false` | Disable publication. CLI defaults to push=true and requires a destination. |
| `--oci-layout DIR` | Complete OCI layout; reject existing nonempty directories. |
| `--tarball FILE` | Single-platform Docker archive; reject existing files. |
| `--local` | Docker load and image inspection; disables push. |
| `--kind` / `--kind-cluster NAME` | Load into an existing Docker-backed kind cluster and verify every node. |
| `--base REF` / `--base-layout DIR` | Registry reference or local OCI layout; mutually exclusive. |
| `--platform LIST` | Comma-separated platforms; default linux/amd64. |
| `--bun-path FILE` | Bun executable for bundling and installation. |
| `--cache-dir DIR` / `--cache-repo REPO` | Local and Registry layer-cache destinations. |
| `--no-cache` | Disable persistent reuse of both layer caches. |
| `--no-local-cache` / `--no-registry-cache` | Disable the respective cache. |
| `--install-cache DIR` | Bun package download cache, separate from the layer cache. |
| `--insecure-registry HOST:PORT` | Explicitly permit HTTP for a host; repeatable. |
| `--dry-run` | Build and estimate transfers with Registry reads; no Registry writes, export, or loading. |
| `--reproducible` | Require an explicit base digest or local base layout. |
| `--verify-deterministic` | Bypass layer caches and compare two staging builds. |
| `--git-metadata=false` | Omit automatic Git labels and Git-derived tags. |
| `--no-index` | Use a single manifest as the image root. |
| `--report FILE` | JSON results; reject existing files and paths within the exported layout. |

Supported environment variables: `BUNKO_REPO`, `BUNKO_CACHE_DIR`, `BUNKO_CACHE_REPO`, `BUNKO_JOBS`, `BUNKO_DOCKER_CONFIG`, `DOCKER_CONFIG`, `BUNKO_DEFAULT_BASE`, `BUNKO_DEFAULT_PLATFORMS`, `SOURCE_DATE_EPOCH`, `XDG_CACHE_HOME`, and `KIND_CLUSTER_NAME`. Explicit CLI values take precedence. Unknown or unsupported options fail rather than being ignored.

Stdout contains one `repo@digest` line on publication success, one content tag for local/kind success, and nothing for export/dry-run. Logs use stderr. Exit status is 0 on success and 1 on failure. Partial tag publication does not emit a success line.

All boolean flags accept `--flag`, `--no-flag`, and `--flag=true|false`; unknown flags and invalid values fail.

Single-target reports use schemaVersion 2; multiple targets use schemaVersion 3 (§8). `images[]` records each platform's manifest, config, base, layers, runtime inventory, and native ELF information. `cache[]` records keys and local/registry/miss/bypass outcomes. `publication` includes reference, published, tags, pendingTags, and transfers. Uploaded bytes count layer/config payloads, or estimates for dry-run, not manifest/index bytes, HTTP overhead, cache publication, or total wire traffic. Compatibility fields at the top level refer to the first platform.

The CLI records `baseRuntimeVerified:false` because it does not run arbitrary bases. `verifiedDeterministic` records the comparison result. Timing is excluded from image identity.

## 3. Inputs, configuration, and dependencies

Entrypoint precedence is `bunko.entrypoint > bin > module > main > src/index.ts > index.ts`. Multiple bin entries require an explicit entrypoint. A broken declared entrypoint is an error, not a reason to fall back.

Supported `package.json.bunko` configuration; all fields are optional:

```json
{
  "entrypoint": "src/server.ts",
  "mode": "bundle",
  "imageName": "hello",
  "base": "oven/bun:1.3.11-slim",
  "platforms": ["linux/amd64", "linux/arm64"],
  "external": ["@node-rs/xxhash"],
  "deps": {"strategy": "production"},
  "assets": ["public"],
  "env": {"NODE_ENV": "production"},
  "ports": [3000],
  "user": "65532:65532",
  "workdir": "/app",
  "args": [],
  "labels": {},
  "runtime": {"bunPath": "/usr/local/bin/bun", "libc": "glibc"},
  "build": {"minify": true, "sourcemap": "none", "define": {}}
}
```

Named bundle entrypoints and their command-override contract are described in [application compatibility](APPLICATION_COMPATIBILITY.md#multiple-entrypoints-in-one-image).

`build.bytecode:false`, `build.target:"bun"`, and `enabled:true` are also accepted. Unknown keys and unsupported values fail. Sourcemaps support none/external. Source symlinks, macros, unsupported import attributes, and computed application require/import expressions are rejected. A trusted worker under the selected Bun executable validates loaded executable inputs before parsing. Application import checks use the syntax tree. Copy-only assets and unreachable modules are not executable inputs. Static json/text/file/toml attributes and import resolution-mode attributes are supported. See [application compatibility](APPLICATION_COMPATIBILITY.md) for bunfig settings and explicit dependency allowances.

Base/platform precedence: CLI > BUNKO_DEFAULT_BASE/BUNKO_DEFAULT_PLATFORMS > package.json > defaults. The default base is `oven/bun:<selected Bun version>-distroless`; automatic catalog pinning is not implemented. Native dependencies require an explicit base containing their shared libraries instead of implicit distroless.

A nonempty dependencies/devDependencies/optionalDependencies/peerDependencies field requires a text `bun.lock`. Only v1 text locks are accepted. Root declarations, optional peer metadata, overrides/resolutions, and patchedDependencies are cross-checked. Entries without integrity, unknown schemas, and file/link/git/tarball specifications are rejected. Workspace protocol support is constrained by §8. Patch contents participate in dependency identity.

Build dependencies are installed for the host in a copy of the source snapshot. Runtime externals use a separate `--production --os=linux --cpu=x64|arm64` install. Both use `--ignore-scripts --linker=isolated --backend=copyfile` and verify that manifest and lock bytes did not change. Checkout node_modules are never copied, and the original source is not modified. Always set an explicit Bun download-cache directory; without `--install-cache`, use temporary build staging outside node_modules.

The production strategy preserves the complete production tree; closure reduction is described in §9. Package data, peer contexts, and internal symlinks are retained. Escaping or dangling links and runtime packages declaring preinstall/install/postinstall are rejected. External roots must be declared production/optional/peer dependencies. Unresolved imports and typos are never automatically externalized.

A packaged `.node` file must be a little-endian ELF64 shared object with System V/GNU OSABI for the target architecture; DT_NEEDED is recorded. Prebuilt `.node` files for other platforms that ship in the same package (for example one file per target triple) and links to them are omitted from the image and counted when runtime files are walked; a named package whose addons include none for the target fails. Unknown addon formats and corrupt target ELF files fail instead of being classified as foreign. If Bun installs both glibc and musl optional variants, the tree is preserved. Arbitrary base ABI/shared-library checks and native source compilation are not performed. The glibc prebuilt addon in examples/dependencies has run on amd64/arm64.

Private npm configuration comes from HTTPS registries, scoped registries, and credentials in `.npmrc`, with `${ENV_NAME}` expansion. Credential files exist only in install staging with mode 0600 and are removed afterward. Credentials do not enter snapshots, cache keys, images, reports, or raw install-error logs. Noncredential registry settings affecting resolution participate in production cache keys.

## 4. Snapshot, bundle, and layers

Source identity includes file contents, normalized modes, relative paths, and directory entries. It excludes mtimes and absolute checkout paths. The snapshot is not reduced to reachable source files.

Excluded paths include `.git`, `.cursor`, node_modules, `.bunko-build`, `.bunko-output`, `.bunko-cache`, `.docker`, `.aws`, `.config`, `.env*`, `.npmrc`, `.yarnrc.yml`, `.DS_Store`, and explicit output/report/cache destinations.

Bun receives an argv array, an explicit empty configuration, a small child environment, and `--no-env-file --env=disable --reject-unresolved`. Bundles use ESM, target=bun, packages=bundle, and minify=true by default. Output names are retained and the metafile identifies the server entry. HTML/browser output and external sourcemaps are collected from the emitted tree. Sourcemap paths normalize to stable `bunko:///` paths.

Assets accept project-relative files, directories, and globs. Unmatched patterns, case collisions, file/parent-child path conflicts, and overlap with runtime node_modules fail. Layer order is `base → deps → assets → app`; empty layers are omitted and additions live under workdir.

Tar entries use UTF-8 byte ordering, explicit parent directories, uid/gid=0, empty owner names, mtime=SOURCE_DATE_EPOCH, regular mode 0644, executable/directory mode 0755, and symlink mode 0777. PAX handles long paths, link paths, and timestamps. Gzip uses level 6, mtime 0, no filename, and OS byte 255. Compressed digest and uncompressed tar DiffID are calculated separately while streaming.

SOURCE_DATE_EPOCH defaults to 0 and accepts nonnegative integer seconds through the end of year 9999. It also controls image.created and new history entries. Reproducibility requires the same snapshot, dependency contents, configuration, Git metadata, Bun/toolchain, packer implementation, base digest, platform, and epoch.

## 5. OCI composition, Registry publication, and export

Resolve a base tag once per invocation. Support OCI and Docker schema 2 manifests/indexes with raw/gzip/zstd layers; verify digest, size and bounded decompression. Schema 1 and foreign layers are unsupported. Base bodies remain lazy until needed; existence checks and same-Registry mounts can avoid transfers.

Preserve base layer bytes and DiffIDs. Inherit environment, user, and ordinary labels, then apply application overrides. Do not inherit reserved bunko or Git revision labels.

- Entrypoint: `[runtime.bunPath, workdir + emitted server path]`.
- Cmd: configured args, default `[]`.
- WorkingDir: configured value or `/app`.
- User: explicit setting, then nonempty base User, then `65532:65532`.
- Env: base, then NODE_ENV=production, then application overrides; ordered by key.
- History: preserve and append only when the base has history; verify empty_layer/DiffID counts.

A base's explicit root user remains root. Examples explicitly select nonroot. Read-only rootfs is a runtime setting.

See [REGISTRIES.md](REGISTRIES.md) for authentication and provider setup. After every platform builds, publish blobs/configs, platform manifests, the root index, then tags. GET/HEAD have bounded retries. PATCH normally uses 8 MiB chunks; ambiguous results are reconciled using upload offsets and destination HEAD. GHCR and Artifact Registry use a streamed full-file PUT, with digest reconciliation and a fresh upload session for bounded transient retries. Manifest PUT results are read back and checked by digest. Partial failures retain published-state details in reports without rolling tags back.

Complete layouts collect every reachable blob in a temporary directory and rename it into place. Docker archives contain manifest.json, configs, and verified uncompressed layer.tar entries. Tarballs/reports never overwrite existing files. Local loading performs Docker load plus inspect. Kind loading uses image-archive and verifies every node with crictl inspecti.

## 6. Cache

The local cache stores CAS blobs and atomic key records under `${XDG_CACHE_HOME:-~/.cache}/bunko/v1`. Registry caches use `bunko-cache-v1-{deps|assets|app}-<full-key>` tags in the image repository or a specified cache repository. The custom OCI artifact's config includes schema, key, kind, pack format, destination, platform, descriptor, DiffID, inventory, and native metadata.

Production dependency keys include dependency manifest fields, the full lock, patches, noncredential registry settings, Bun version/revision, target platform, base digest, libc, strategy/linker, externals, destination, epoch, and pack format. They exclude app source, credentials, host absolute paths, and image tags. Asset keys include contents/mode/path, destination, epoch, and pack format and can be shared across platforms. Closure keys are described in §9.

Lookup order is local, Registry metadata, then miss. Local blobs are checked by compressed digest and DiffID. Registry cache bodies are fetched and verified during preparation, with bounded compressed/decompressed sizes. Invalid metadata, unavailable caches, and corrupt bodies cause a diagnostic and miss before publication. Base-image bodies remain lazy and are separate from cache validation.

New records are saved after independent construction/determinism checks succeed. Registry cache publication follows successful image publication. Cache write failure does not undo image success. Application caching, cross-process locks, explicit pruning, and bounded target preparation with `--jobs` are implemented; see the performance contract below.

Determinism verification bypasses persistent layer caches on both runs and compares layers/configs/platform manifests and inventory. Bun's download cache may still be reused. Dry-run may use local caches and download packages and may write its report, but performs no Registry writes, export, or loading.

## 7. Validation

`bun run check` runs typechecking and offline unit/integration tests. Python tarfile independently checks tar/PAX and Docker archive output. `test:build-smoke` uses real Distribution, public npm/base images, and Docker to verify both build platforms, determinism, dependency/asset reuse after source edits, verified pull/run, and local loading.

Cloud Registry coverage is recorded per provider in the [Registry matrix](REGISTRIES.md). Arbitrary native ABIs, musl runtime, live HTML serving, other Bun versions, and repeated comparative performance measurements remain unverified. [Validation records](VALIDATION.md) distinguish measurements from limitations.

## 8. Workspaces and multiple targets

An ancestor becomes the workspace root only if its workspaces declaration matches the selected package. Unrelated or malformed ancestor manifests do not capture standalone projects. The root `package.json.workspaces` must be an array of positive relative globs or an object with a `packages` array and optional `catalog`/`catalogs` definitions. Leading `./` segments and trailing slashes are normalized consistently for discovery and ancestor membership checks; `./packages/*` and `packages/*` select the same members. Member names are unique. Declared and discovered membership is cross-checked against the root lock, including root/member names, versions, dependency declarations, and optional peers. Manifest or membership changes during snapshotting fail.

A member directory searches parent declarations and uses the common lock. Root discovery excludes enabled:false, prefers children with bunko settings, and otherwise chooses bin/module children. Zero candidates fail. Use `--target .` for the root or repeat package names/root-relative paths for members. Deduplicate targets and process by path. Root application settings are not inherited implicitly; use explicit [`bunko.defaults`](CONFIGURATION.md) for shared member defaults.

Validate all target settings, image-name collisions, output restrictions, and lock consistency before building. Bare/tarball output requires one target. Every selected target/platform and determinism check must succeed before export/push/load. Base tag metadata is shared within the invocation.

Snapshot the common root once. Build and Linux runtime installs preserve workspace-relative topology in separate staging directories. Bundle from the member directory with the entire snapshot as the metafile/sourcemap boundary. Root-relative tsconfig extends and source imports across members are allowed.

Ordinary workspace dependencies are bundled. With production externals, root/member production node_modules and the files of potentially referenced workspace packages are placed under `workdir/.bunko-workspace`. Preserve Bun's topology and peer contexts, and link each selected service's external roots from `workdir/node_modules/<package>`. Workdir, app, and asset placement are unchanged. Missing externals, links outside the admitted runtime, and install-script-dependent packages fail.

Production images may include other services' dependencies and already bundled shared packages. Workspace packages without a declared version use an empty inventory version. See §9 for closure/sharedDeps.

Workspace production keys include every member's dependency-related manifest, the full lock, target path, layout version, and potentially reachable workspace source bytes. Service-only edits reuse dependencies; runtime workspace edits miss. Source digest covers the complete root snapshot, so unrelated service changes may still alter another image's config/root digest.

A multi-target OCI layout has one index.json referring to named target roots, with reachable blobs deduplicated. Single-target export is unchanged.

Multi-target reports use `{schemaVersion:3,status,targets:[BuildResult...]}`, with targetPath on each result. Failures add error and pendingTargets while retaining published roots/tags and pending tags. Publication and loading have no cross-target transaction. Stdout appears only when every requested target succeeds.

`buildTargets(options)` returns multiple results. `build(options)` retains its single-result API and rejects multiple selections before side effects.

Default and named catalog references are supported for registry dependencies. Define catalogs at the workspace root, either as top-level fields or inside `workspaces`; declaring the same field in both locations is rejected. Missing catalog entries, recursive catalog references, and non-registry catalog entries fail before installation. Catalog declarations are checked against the frozen lock and included in dependency cache identity. Member-local catalogs are unsupported.

Unsupported workspace forms: nested members, negative globs, file/link packages, and member-local npmrc/overrides/resolutions/patchedDependencies. Put the latter at the root. Workspace install settings belong in the root bunfig.toml; member test settings may be present but are ignored. See the application compatibility policy for install-script declarations.

## 9. Dependency closure and sharedDeps

`bunko.deps.strategy` / `--deps-strategy` accepts production (default) or closure. Closure installs the original manifests/lock for Linux without rewriting them, then follows dependencies, optionalDependencies, and peerDependencies from explicit externals using installed node_modules resolution. Missing optional/optional-peer edges are allowed; missing required edges fail. There is no independent semver resolver.

Project each concrete instance's package files, including workspace source, JSON/data, licenses, and executable modes, under `workdir/.bunko-deps`. Add links for resolved dependency edges, except when a bundled dependency already occupies that exact nested path. Keep distinct versions and peer contexts as distinct instances. Exclude unreachable node_modules and dev dependencies. Preserve dependency bin links and reject bin-name collisions within a scope. Runtime imports must be declared dependencies, optional dependencies, or peers; accidental access to undeclared hoisted packages is unsupported.

Root `bunko.sharedDeps:true` or `--shared-deps` prepares the union of selected closures once. All targets must use closure and matching workdir/base/platforms. Closure is selected when no strategy was specified. Target aliases live in app layers; the shared dependency digest matches per platform. A single-target invocation shares only that target's closure.

File hashing is limited to 16 concurrent reads and preserves input order. Closure keys hash every projected file's SHA256, mode, path, links, layout version, toolchain, platform, base digest, workdir, epoch, and pack format. The full lock is excluded from the key, but lock validation and frozen Linux install still run every time. Cache hits reuse layer compression/transfers while retaining install/graph verification. Production cache hits continue to skip the Linux install. Different sources or patches yielding identical projected bytes can reuse a closure layer.

Projection checks escaping links, special files, install-script requirements, and native ELF/platform compatibility. App/assets cannot overwrite .bunko-deps or node_modules. Determinism verification constructs graphs from separate installs.

## 10. Resolve

`bunko resolve -f FILE|DIR|- --repo PREFIX [--context DIR]` accepts repeated inputs. Input paths are cwd-relative; URI paths are cwd- or context-relative, or absolute. Directories read regular .yaml/.yml/.json files by name; only --recursive visits children. Child symlinks are not followed. Explicit files are deduplicated by canonical path, and repeated stdin is read once.

Use a YAML AST to identify complete bunko://path string values and their source ranges. Do not replace mapping keys or their descendants, comments, strings that do not begin with bunko://, or ${...}/{{...}} templates. URI query/fragment/backslash/control characters are rejected. YAML errors/warnings, unknown tags, duplicate keys, and undefined aliases fail before building.

Validate the decoded scalar value without trimming it. A non-template value starting with `bunko://` must contain no whitespace, including trailing spaces or newlines; otherwise fail with `Invalid bunko reference` before building. A literal block using `|` normally retains its final newline and therefore fails this rule. Use `|-` for a literal URI block, or `>-` for a single-line folded block, so the decoded value has no final newline. The rule applies to the decoded value, not merely the block style: stripping the final newline does not make embedded whitespace or trailing spaces valid. Block-scalar header comments remain preserved for valid replacements.

Replace only selected ranges with quoted scalars. Preserve comments, boundaries, anchors/aliases, untouched numeric spelling, and block-scalar header comments. Reject an image anchor reused as a mapping key because replacing it would change the key. A scalar anchored in a key can be referenced as a value by replacing that alias only. A collection anchored in a mapping key and containing image references cannot be aliased into a value.

Inputs valid as JSON are treated as JSON; invalid .json files fail. One all-JSON input remains JSON; multiple all-JSON inputs become an array of inputs. Mixed/YAML inputs form a stream separated by explicit document ends without adding empty documents for existing ends or comment-only files. Add a YAML 1.2 directive when necessary to prevent a preceding file's YAML 1.1 schema from leaking into the next input. Untouched JSON values are not reserialized through JavaScript objects.

Parse all inputs, deduplicate canonical targets, validate settings, prepare every image grouped by workspace, validate completed output, publish every image, write the report, then emit stdout. Share base metadata resolution across source contexts. Ambiguous workspace-root references must select a service directory. Image names must be unique across contexts. Bare publication requires one resolved target.

Resolve publishes by default, or loads local Docker/kind images with --local/--kind. It rejects standalone push=false, layout/tarball/dry-run/--target. Inputs with no references need no Registry access. No publication or loading begins before all builds finish and output is rendered. Only successful completion of every target emits stdout. Earlier published or loaded images can remain after a later failure.

Reports use schemaVersion 4, command=resolve, status, and targets. Success adds URI-to-immutable-reference mappings. Preparation/publication failure adds error and canonical pendingTargets. Syntax/discovery errors happen before report creation. Reports never overwrite existing files.

`resolveDocuments(options)` returns `{output,targets}` without writing stdout. The preparation API returns finish/dispose functions. Finish may be called once; callers must always dispose.

The [correctness review follow-up](REVIEW_FIXES.md) records transfer deadlines, normalized Registry origins, upload-status compatibility, cache-key invalidation, and validation of these fixes.

## 11. Supply-chain metadata and compile

[SUPPLY_CHAIN.md](SUPPLY_CHAIN.md) defines the implemented metadata, private signing, compile, and check-base contract, including coverage limits and validation commands. Metadata is opt-in and is attached by subject without changing runnable image identity. Required attachment/signing failures fail publication as a whole and withhold stdout, even if the image itself has already been published.

## 12. Operations

[OPERATIONS.md](OPERATIONS.md) defines prepared dependency artifact validation, apply ordering, and local/remote pruning. Mutation requires explicit commands. Ordinary build/resolve behavior does not implicitly apply resources or delete caches.

## 13. Performance contract

Target preparation accepts bounded `--jobs` (1–32, default 1). All targets prepare before publication; output/report target ordering is stable. Application cache hits reuse verified packed output and skip build-only installation/bundling. Keys include source, toolchain executable, host/target, base, dependency/alias and build inputs. `--no-app-cache` disables this cache; `--verify-deterministic` bypasses every layer cache. Syntax validation is content-keyed within an invocation, rereading bytes on every check. Local writers serialize with prune; conflicting valid outputs under a key are rejected. Registry hits are verified during preparation, with a 2 GiB compressed/decompressed limit. See PERFORMANCE.md.

## 14. Diagnostics

`check-config [path]` validates manifests, workspace/target selection, named entry configuration, selected external asset bindings/filesystem entries and the text-lock dependency contract without installing or contacting registries. `doctor [path]` additionally checks the selected Bun revision and optional executable availability. JSON reports omit configured environment/define values and list unchecked build/runtime/network concerns. Command-specific options are rejected outside their supported commands, including explicit negative booleans. See COMPATIBILITY.md for the tested Bun matrix and migration details.

## Portable ko feature additions

Repeated `--image-label`, `--image-annotation` and `--image-user` override matching package metadata. `bunko.annotations` is a string map applied to platform manifests and the runnable index. `--image-refs` atomically creates a new newline-delimited immutable registry reference list after successful publication; partial publication stays in the JSON report. Apply emits publication references independently of later Kubernetes success.

`resolve`/`apply --selector` filter top-level documents by metadata.labels using equality, inequality, existence and nonempty set requirements. No matches produce no output or Kubernetes operation. Selector mode may normalize YAML formatting; ordinary resolution preserves source text. A real target `bunkodata/` directory is included as assets and sets BUNKO_DATA_PATH under the workdir, subject to existing source/symlink exclusions. See [COMPARISON.md](COMPARISON.md) for researched differences and limits.

## Input selection and progress

A root `.bunkoignore` accepts positive root-relative Bun globs, blank lines and `#` comments. Matching directories are pruned; use `**/name` for matches at arbitrary depths. Negation, absolute paths, backslashes and parent traversal are rejected. The ignore file itself always participates in source identity. Required manifests, imports and explicit assets must still be present; ignored conventional data is an error. This is not gitignore syntax.

Workspace application cache keys retain whole reachable member trees, every package/tsconfig manifest and root inputs. Unknown resolution, npm imports, escaped specifiers, HTML/CSS imports or tsconfig path aliases fall back to the complete snapshot. Source audit labels still represent the entire snapshot and can change the image digest even when app output is reused. Ordinary bundle output is shared across platforms within a single independent build iteration; compiled output remains platform-specific.

`--progress=json` emits schema-versioned snapshot, prepare and publish events to stderr with start/completion/failure status and durations. Compiler/build logs use separate JSON log records and failures use JSON error records after progress configuration is parsed. Stdout retains its command-specific contract. Durations never participate in image identity.

## Local resolution and OCI interoperability

Resolve supports local Docker and kind loading in addition to Registry publication. Kind apply explicitly selects the matching kind context. See [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md). Per-target dependency maps support standalone and target-bound workspace artifacts; see the [preparation recipe](../examples/prepared-dependencies/README.md).

Zstd-compressed OCI base layers are supported without recompression during composition. Zstd descriptors are limited to 2 GiB compressed; decoding defaults to 2 GiB output and a 128 MiB maximum decoder window. Docker export verifies decompressed DiffIDs. Generated application layers remain gzip. Custom CA and mutual TLS settings are host-scoped; see [REGISTRIES.md](REGISTRIES.md).

## Metadata extraction and producer policy

`metadata IMAGE@DIGEST|layout:DIR --metadata-dir DIR` exports verified SPDX and provenance payloads. `--base-sbom linux/ARCH=ARTIFACT@DIGEST` links a base inventory bound to the selected platform manifest. `--deps-verify-key` checks prepared dependency signatures before import. The opt-in `--supply-chain-policy ci` requires reproducible builds, image/metadata signing, both metadata types and prepared dependency verification where applicable. See [METADATA.md](METADATA.md) for coverage and trust limitations.

Builder identity is an input to application caching and runnable image labels. Distributed CLI runs hash the actual JavaScript bundle; source runs fingerprint TypeScript sources, package.json and bun.lock. Two different installations, bundles or source revisions can therefore produce different image digests despite sharing a version string. Reproducibility requires the same builder fingerprint as well as the same application, toolchain and base inputs.

## Cache distribution and managed retention

`--cache-from` supplies ordered additional Registry read sources; `--cache-repo` remains the single write destination. `--cache-write=false` disables Registry cache writes independently of reads. `cache-info` reports validated local metadata and referenced blob bytes. `prune --keep-bytes N` previews oldest-metadata-first removal within that managed scope; `--execute` is required for deletion. Unknown and unreferenced files are untouched. See [CACHE_RETENTION.md](CACHE_RETENTION.md).

### Named asset contexts

`bunko.assetMappings` accepts `{context, from, to}` records. `--asset-context NAME=DIR` binds each logical context to a local directory. `from` selects an exact relative file or subtree; `to` is its exact absolute image destination. Only selected inputs are frozen. Exclusions, symlink rejection, protected destinations, cross-layer collisions, content-based caching, and logical material provenance follow the [application compatibility contract](APPLICATION_COMPATIBILITY.md#named-local-asset-contexts). Host context paths are not persisted in materials.


## Injected runtime layers

`runtime.inject: "release"` optionally adds a signed official Bun runtime layer between the base and dependencies. It requires an explicit glibc base and bundle mode; supported versions, verification policy, cache behavior, licensing notices and execution checks are specified in [runtime injection](RUNTIME_INJECTION.md). It does not alter normal runtime inheritance or imply that native addon libraries are installed.

## Build telemetry

`--otel` explicitly enables bounded OTLP/HTTP JSON metrics and traces for build, resolve and apply. Standard OTel variables alone never enable transmission. Stage boundaries are shared with progress events and local report timings; target identities are replaced with invocation-local numbers in exported traces. Supported configuration, signal definitions, privacy limits, export deadlines and Collector interoperability are defined in [TELEMETRY.md](TELEMETRY.md). This feature is included starting with rc.3.

### Compile output boundary

Compile mode currently accepts a single emitted JavaScript server entrypoint. Literal dynamic imports that Bun includes in that output are supported. Builds that emit additional files, including HTML routes, browser JavaScript and CSS, fail before compilation with `Compile mode requires a single JavaScript output`. Use bundle mode for those applications. This avoids deleting assets that the recompiled server still references; compile mode does not yet compile HTML routes directly from source. External sourcemaps remain unsupported in compile mode.

## Additions in rc.4

The current source contract additionally includes [source-preserving packaging](SOURCE_MODE.md), [explicit workspace defaults, local toolchain requirements, runtime arguments, asset exclusions/modes and application CA certificates](CONFIGURATION.md), and [prepared base layouts with bounded offline builds](OFFLINE.md). These focused specifications define the corresponding configuration and validation boundaries. The immutable rc.3 release does not include these additions.

Source mode preserves the sanitized source tree and the production dependency topology, supports computed runtime imports, and invokes Bun with `--no-install`. It rejects bundler options, invocation defines, closure and shared dependency strategies. Runtime argument arrays precede the source entrypoint; compiled applications use ordinary application arguments instead.

[System font asset mappings](FONTS.md) permit validated non-executable fonts and accompanying notices beneath `/usr/share/fonts` and `/usr/local/share/fonts`, with per-platform base path checks. Renderer discovery and color-format support remain application/base concerns; the guide records tested configurations and limitations.

### Layer ownership and local references

Generated layers only synthesize parent directory entries within their declared application or asset destination roots. Ancestors above those roots retain the base image's ownership and permissions, including `/tmp`'s sticky bit. Runtime injection writes its files without synthesizing ancestor directory metadata. Explicit directory entries still describe application-owned directories. Layer appliers create missing parent directories using their normal extraction rules. Imported dependency artifacts are extracted, validated and repacked with current ownership rules before use; their original tar metadata is never attached directly. All ancestor paths remain subject to collision validation, even when omitted from the tar. Each archive path component is limited to 255 UTF-8 bytes; longer complete paths use PAX records.

This serialization change uses `tar-gzip-v4` cache identities; previous layer cache records are not reused. Base layer descriptor annotations are preserved. OCI layout image references are fully qualified (`bunko.local/<name>:<first-tag>` for local builds), so containerd-backed importers can address the imported image. See the [OCI layer application rules](https://github.com/opencontainers/image-spec/blob/main/layer.md#changeset-over-existing-files) for directory attribute replacement semantics.
