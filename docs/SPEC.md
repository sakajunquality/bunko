# bunko implementation specification — M2

2026-09-08. This document describes the implemented contract. See [DESIGN.md](DESIGN.md) for future design, [the archived v0.1 proposal](archive/SPEC-v0.1.md) for the original concept, and [VALIDATION.md](VALIDATION.md) for measurements and unverified behavior.

## 1. Scope

Bundle standalone and workspace Bun applications, compose them with base images, and publish to OCI Registries, export complete OCI layouts or Docker archives, or load into Docker/kind. Supported Bun range: `>=1.3.11 <1.4`; validation baseline: 1.3.11. The distributed `dist/bunko.js` has no external npm runtime dependencies. Its pinned parsers, `yaml` 2.9.0 and TypeScript 5.9.3, are bundled with their licenses.

A build can target `linux/amd64` and `linux/arm64` together. An omitted arm64 variant means v8. Platforms have a stable index order. Building never executes target binaries or emulators. Docker archives, local/kind loading, and `--no-index` require one platform.

Supported dependencies are registry npm packages, constrained workspace references, and explicit production runtime externals. Compile, bytecode, SBOM/provenance/signing, apply, external dependency artifacts, and pruning remain future milestones.

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

Supported environment variables: `BUNKO_REPO`, `BUNKO_CACHE_DIR`, `BUNKO_CACHE_REPO`, `BUNKO_DOCKER_CONFIG`, `DOCKER_CONFIG`, `BUNKO_DEFAULT_BASE`, `BUNKO_DEFAULT_PLATFORMS`, `SOURCE_DATE_EPOCH`, `XDG_CACHE_HOME`, and `KIND_CLUSTER_NAME`. Explicit CLI values take precedence. Unknown or unsupported options fail rather than being ignored.

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

`build.bytecode:false`, `build.target:"bun"`, and `enabled:true` are also accepted. Unknown keys and unsupported values fail. Sourcemaps support none/external. Project bunfig.toml, source symlinks, import attributes/macros, and computed application require/import expressions are rejected. Import attributes and macros are detected from parsed syntax without executing source, so matching comments and strings are accepted. Computed-import detection remains conservative.

Base/platform precedence: CLI > BUNKO_DEFAULT_BASE/BUNKO_DEFAULT_PLATFORMS > package.json > defaults. The default base is `oven/bun:<selected Bun version>-distroless`; automatic catalog pinning is not implemented. Native dependencies require an explicit base containing their shared libraries instead of implicit distroless.

A nonempty dependencies/devDependencies/optionalDependencies/peerDependencies field requires a text `bun.lock`. Only v1 text locks are accepted. Root declarations, optional peer metadata, overrides/resolutions, and patchedDependencies are cross-checked. Entries without integrity, unknown schemas, and file/link/git/tarball specifications are rejected. Workspace protocol support is constrained by §8. Patch contents participate in dependency identity.

Build dependencies are installed for the host in a copy of the source snapshot. Runtime externals use a separate `--production --os=linux --cpu=x64|arm64` install. Both use `--ignore-scripts --linker=isolated --backend=copyfile` and verify that manifest and lock bytes did not change. Checkout node_modules are never copied, and the original source is not modified. Always set an explicit Bun download-cache directory; without `--install-cache`, use temporary build staging outside node_modules.

The production strategy preserves the complete production tree; closure reduction is described in §9. Package data, peer contexts, and internal symlinks are retained. Escaping or dangling links and runtime packages declaring preinstall/install/postinstall are rejected. External roots must be declared production/optional/peer dependencies. Unresolved imports and typos are never automatically externalized.

Native `.node` files must be little-endian ELF64 for the target architecture; DT_NEEDED is recorded. If Bun installs both glibc and musl optional variants, the tree is preserved. Arbitrary base ABI/shared-library checks and native source compilation are not performed. The glibc prebuilt addon in examples/dependencies has run on amd64/arm64.

Private npm configuration comes from HTTPS registries, scoped registries, and credentials in `.npmrc`, with `${ENV_NAME}` expansion. Credential files exist only in install staging with mode 0600 and are removed afterward. Credentials do not enter snapshots, cache keys, images, reports, or raw install-error logs. Noncredential registry settings affecting resolution participate in production cache keys.

## 4. Snapshot, bundle, and layers

Source identity includes file contents, normalized modes, relative paths, and directory entries. It excludes mtimes and absolute checkout paths. The snapshot is not reduced to reachable source files.

Excluded paths include `.git`, `.cursor`, node_modules, `.bunko-build`, `.bunko-output`, `.bunko-cache`, `.docker`, `.aws`, `.config`, `.env*`, `.npmrc`, `.yarnrc.yml`, `.DS_Store`, and explicit output/report/cache destinations.

Bun receives an argv array, an explicit empty configuration, a small child environment, and `--no-env-file --env=disable --reject-unresolved`. Bundles use ESM, target=bun, packages=bundle, and minify=true by default. Output names are retained and the metafile identifies the server entry. HTML/browser output and external sourcemaps are collected from the emitted tree. Sourcemap paths normalize to stable `bunko:///` paths.

Assets accept project-relative files, directories, and globs. Unmatched patterns, case collisions, file/parent-child path conflicts, and overlap with runtime node_modules fail. Layer order is `base → deps → assets → app`; empty layers are omitted and additions live under workdir.

Tar entries use UTF-8 byte ordering, explicit parent directories, uid/gid=0, empty owner names, mtime=SOURCE_DATE_EPOCH, regular mode 0644, executable/directory mode 0755, and symlink mode 0777. PAX handles long paths, link paths, and timestamps. Gzip uses level 6, mtime 0, no filename, and OS byte 255. Compressed digest and uncompressed tar DiffID are calculated separately while streaming.

SOURCE_DATE_EPOCH defaults to 0 and accepts nonnegative integer seconds through the end of year 9999. It also controls image.created and new history entries. Reproducibility requires the same snapshot, dependency contents, configuration, Git metadata, Bun/toolchain, packer implementation, base digest, platform, and epoch.

## 5. OCI composition, Registry publication, and export

Resolve a base tag once per invocation. Support OCI and Docker schema 2 manifests/indexes with gzip/raw layers; verify digest and size. Schema 1, zstd, and foreign layers are unsupported. Base bodies remain lazy until needed; existence checks and same-Registry mounts can avoid transfers.

Preserve base layer bytes and DiffIDs. Inherit environment, user, and ordinary labels, then apply application overrides. Do not inherit reserved bunko or Git revision labels.

- Entrypoint: `[runtime.bunPath, workdir + emitted server path]`.
- Cmd: configured args, default `[]`.
- WorkingDir: configured value or `/app`.
- User: explicit setting, then nonempty base User, then `65532:65532`.
- Env: base, then NODE_ENV=production, then application overrides; ordered by key.
- History: preserve and append only when the base has history; verify empty_layer/DiffID counts.

A base's explicit root user remains root. Examples explicitly select nonroot. Read-only rootfs is a runtime setting.

See [REGISTRIES.md](REGISTRIES.md) for authentication and provider setup. After every platform builds, publish blobs/configs, platform manifests, the root index, then tags. GET/HEAD have bounded retries. PATCH normally uses 8 MiB chunks; ambiguous results are reconciled using upload offsets and destination HEAD. Artifact Registry uses a streamed full-file PUT, with digest reconciliation and a fresh upload session for bounded transient retries. Manifest PUT results are read back and checked by digest. Partial failures retain published-state details in reports without rolling tags back.

Complete layouts collect every reachable blob in a temporary directory and rename it into place. Docker archives contain manifest.json, configs, and verified uncompressed layer.tar entries. Tarballs/reports never overwrite existing files. Local loading performs Docker load plus inspect. Kind loading uses image-archive and verifies every node with crictl inspecti.

## 6. Cache

The local cache stores CAS blobs and atomic key records under `${XDG_CACHE_HOME:-~/.cache}/bunko/v1`. Registry caches use `bunko-cache-v1-{deps|assets}-<full-key>` tags in the image repository or a specified cache repository. The custom OCI artifact's config includes schema, key, kind, pack format, destination, platform, descriptor, DiffID, inventory, and native metadata.

Production dependency keys include dependency manifest fields, the full lock, patches, noncredential registry settings, Bun version/revision, target platform, base digest, libc, strategy/linker, externals, destination, epoch, and pack format. They exclude app source, credentials, host absolute paths, and image tags. Asset keys include contents/mode/path, destination, epoch, and pack format and can be shared across platforms. Closure keys are described in §9.

Lookup order is local, Registry metadata, then miss. Local blobs are checked by compressed digest and DiffID. Remote bodies are fetched and checked only when required; when the destination already has the blob, even the cache body GET can be skipped. Invalid metadata or unavailable caches cause a diagnostic and miss. Corrupt fetched layer bodies fail because they cannot be reused safely.

New records are saved after independent construction/determinism checks succeed. Registry cache publication follows successful image publication. Cache write failure does not undo image success. App build caching, cross-process locks, pruning, and `--jobs` are not implemented; execution is primarily sequential.

Determinism verification bypasses persistent layer caches on both runs and compares layers/configs/platform manifests and inventory. Bun's download cache may still be reused. Dry-run may use local caches and download packages and may write its report, but performs no Registry writes, export, or loading.

## 7. Validation

`bun run check` runs typechecking and offline unit/integration tests. Python tarfile independently checks tar/PAX and Docker archive output. `test:m1-smoke` uses real Distribution, public npm/base images, and Docker to verify both build platforms, determinism, dependency/asset reuse after source edits, verified pull/run, and local loading.

Cloud Registry coverage is recorded per provider in the [Registry matrix](REGISTRIES.md). Arbitrary native ABIs, musl runtime, live HTML serving, other Bun versions, and repeated comparative performance measurements remain unverified. [Validation records](VALIDATION.md) distinguish measurements from limitations.

## 8. Workspaces and multiple targets (M2a)

An ancestor becomes the workspace root only if its workspaces declaration matches the selected package. Unrelated or malformed ancestor manifests do not capture standalone projects. The root `package.json.workspaces` must be an array of positive relative globs. Member names are unique. Declared and discovered membership is cross-checked against the root lock, including root/member names, versions, dependency declarations, and optional peers. Manifest or membership changes during snapshotting fail.

A member directory searches parent declarations and uses the common lock. Root discovery excludes enabled:false, prefers children with bunko settings, and otherwise chooses bin/module children. Zero candidates fail. Use `--target .` for the root or repeat package names/root-relative paths for members. Deduplicate targets and process by path. Root application settings are not inherited.

Validate all target settings, image-name collisions, output restrictions, and lock consistency before building. Bare/tarball output requires one target. Every selected target/platform and determinism check must succeed before export/push/load. Base tag metadata is shared within the invocation.

Snapshot the common root once. Build and Linux runtime installs preserve workspace-relative topology in separate staging directories. Bundle from the member directory with the entire snapshot as the metafile/sourcemap boundary. Root-relative tsconfig extends and source imports across members are allowed.

Ordinary workspace dependencies are bundled. With production externals, root/member production node_modules and the files of potentially referenced workspace packages are placed under `workdir/.bunko-workspace`. Preserve Bun's topology and peer contexts, and link each selected service's external roots from `workdir/node_modules/<package>`. Workdir, app, and asset placement are unchanged. Missing externals, links outside the admitted runtime, and install-script-dependent packages fail.

Production images may include other services' dependencies and already bundled shared packages. Workspace packages without a declared version use an empty inventory version. See §9 for closure/sharedDeps.

Workspace production keys include every member's dependency-related manifest, the full lock, target path, layout version, and potentially reachable workspace source bytes. Service-only edits reuse dependencies; runtime workspace edits miss. Source digest covers the complete root snapshot, so unrelated service changes may still alter another image's config/root digest.

A multi-target OCI layout has one index.json referring to named target roots, with reachable blobs deduplicated. Single-target export is unchanged.

Multi-target reports use `{schemaVersion:3,status,targets:[BuildResult...]}`, with targetPath on each result. Failures add error and pendingTargets while retaining published roots/tags and pending tags. Publication and loading have no cross-target transaction. Stdout appears only when every requested target succeeds.

`buildTargets(options)` returns multiple results. `build(options)` retains its single-result API and rejects multiple selections before side effects.

Unsupported workspace forms: nested members, object/catalog declarations, negative globs, file/link packages, and member-local npmrc/overrides/resolutions/patchedDependencies. Put the latter at the root. Project bunfig and install-script restrictions are unchanged.

## 9. Dependency closure and sharedDeps (M2b)

`bunko.deps.strategy` / `--deps-strategy` accepts production (default) or closure. Closure installs the original manifests/lock for Linux without rewriting them, then follows dependencies, optionalDependencies, and peerDependencies from explicit externals using installed node_modules resolution. Missing optional/optional-peer edges are allowed; missing required edges fail. There is no independent semver resolver.

Project each concrete instance's package files, including workspace source, JSON/data, licenses, and executable modes, under `workdir/.bunko-deps`. Add links for resolved dependency edges, except when a bundled dependency already occupies that exact nested path. Keep distinct versions and peer contexts as distinct instances. Exclude unreachable node_modules and dev dependencies. Preserve dependency bin links and reject bin-name collisions within a scope. Runtime imports must be declared dependencies, optional dependencies, or peers; accidental access to undeclared hoisted packages is unsupported.

Root `bunko.sharedDeps:true` or `--shared-deps` prepares the union of selected closures once. All targets must use closure and matching workdir/base/platforms. Closure is selected when no strategy was specified. Target aliases live in app layers; the shared dependency digest matches per platform. A single-target invocation shares only that target's closure.

File hashing is limited to 16 concurrent reads and preserves input order. Closure keys hash every projected file's SHA256, mode, path, links, layout version, toolchain, platform, base digest, workdir, epoch, and pack format. The full lock is excluded from the key, but lock validation and frozen Linux install still run every time. Cache hits reuse layer compression/transfers while retaining install/graph verification. Production cache hits continue to skip the Linux install. Different sources or patches yielding identical projected bytes can reuse a closure layer.

Projection checks escaping links, special files, install-script requirements, and native ELF/platform compatibility. App/assets cannot overwrite .bunko-deps or node_modules. Determinism verification constructs graphs from separate installs.

## 10. Resolve (M2c)

`bunko resolve -f FILE|DIR|- --repo PREFIX [--context DIR]` accepts repeated inputs. Input paths are cwd-relative; URI paths are cwd- or context-relative, or absolute. Directories read regular .yaml/.yml/.json files by name; only --recursive visits children. Child symlinks are not followed. Explicit files are deduplicated by canonical path, and repeated stdin is read once.

Use a YAML AST to identify complete bunko://path string values and their source ranges. Do not replace mapping keys or their descendants, comments, descriptions containing whitespace, or ${...}/{{...}} templates. URI query/fragment/backslash/control characters are rejected. YAML errors/warnings, unknown tags, duplicate keys, and undefined aliases fail before building.

Replace only selected ranges with quoted scalars. Preserve comments, boundaries, anchors/aliases, untouched numeric spelling, and block-scalar header comments. Reject an image anchor reused as a mapping key because replacing it would change the key. A scalar anchored in a key can be referenced as a value by replacing that alias only. A collection anchored in a mapping key and containing image references cannot be aliased into a value.

Inputs valid as JSON are treated as JSON; invalid .json files fail. One all-JSON input remains JSON; multiple all-JSON inputs become an array of inputs. Mixed/YAML inputs form a stream separated by explicit document ends without adding empty documents for existing ends or comment-only files. Add a YAML 1.2 directive when necessary to prevent a preceding file's YAML 1.1 schema from leaking into the next input. Untouched JSON values are not reserialized through JavaScript objects.

Parse all inputs, deduplicate canonical targets, validate settings, prepare every image grouped by workspace, validate completed output, publish every image, write the report, then emit stdout. Share base metadata resolution across source contexts. Ambiguous workspace-root references must select a service directory. Image names must be unique across contexts. Bare publication requires one resolved target.

Resolve requires Registry publication and rejects push=false, layout/tarball/local/kind/dry-run/--target. Inputs with no references need no Registry access. No Registry writes occur before all builds finish. Only successful publication of every target emits stdout. Publication has no transaction or rollback; already published images remain after a later failure.

Reports use schemaVersion 4, command=resolve, status, and targets. Success adds URI-to-immutable-reference mappings. Preparation/publication failure adds error and canonical pendingTargets. Syntax/discovery errors happen before report creation. Reports never overwrite existing files.

`resolveDocuments(options)` returns `{output,targets}` without writing stdout. The preparation API returns finish/dispose functions. Finish may be called once; callers must always dispose.

The [correctness review follow-up](REVIEW_FIXES.md) records transfer deadlines, normalized Registry origins, upload-status compatibility, cache-key invalidation, and validation of these fixes.
