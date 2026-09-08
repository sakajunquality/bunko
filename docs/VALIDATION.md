# Design and implementation validation records

Recorded on 2026-09-07 as supporting evidence for [DESIGN.md](DESIGN.md). Sections 1–7 describe the initial investigation; sections 8–12 record validation after each implementation milestone. Results and outstanding work are historical, not claims that every current feature was available at every stage. Later correctness work is recorded in [REVIEW_FIXES.md](REVIEW_FIXES.md).

## 1. Environment and scope

| Item | Observed value |
| --- | --- |
| Bun | `1.3.11` |
| Bun revision | `af24e281ebacd6ac77c0f14b4206599cf4ae1c9f` |
| OS / CPU | `darwin / arm64` |
| Initial repository | README.md only; `ef64a49 Initial commit`; clean worktree |
| Original specification SHA-256 | `259bd699d4c93736eabbef7560a5bf172f61dc91ce0f147e747314a9c155599e` |

The checksum identifies the original Japanese input, not the English translation in this repository. Initial probes used small, author-created fixtures in temporary directories and the Bun CLI. They did not download external npm packages, run Linux containers, push or mount Registry blobs, or generate OCI tar archives. Later sections record implementation results.

Official documentation reflects its publication state and may describe features beyond Bun 1.3.11. Bytecode and compile support must be tied to the version actually used.

## 2. Initial findings

| Probe | Result | Design consequence |
| --- | --- | --- |
| `Bun.JSONC.parse` | API exists and parses comments/trailing commas | No custom JSONC parser needed |
| `--os` / `--cpu` | Listed in `bun install --help` | Flags exist; target optional packages still require runtime validation |
| Repeated ordinary bundle | Identical output in separate processes | Useful starting fixture for determinism tests |
| Ordinary bundle at different checkout depths | Identical output | This fixture did not embed host paths in ordinary ESM |
| External sourcemap | Path spelling affected output; realpath plus relative outdir made it match | Normalize paths and compare independent staging locations |
| Bytecode | Stable within a checkout, different JS and `.jsc` between checkouts | Exclude from initial support |
| HTML import | Default naming emitted server JS, HTML, and client JS | Preserve the whole output tree |
| HTML with fixed entry naming | `--entry-naming=index.js` caused collisions | Do not force every output entry to one name |
| Workspace lock | Observed minimal version/config/workspaces/packages structure | Use a versioned adapter and compare manifests |
| Frozen workspace install | Accepted a workspace-only manifest mismatch | Do not rely on the frozen flag alone |

## 3. Bundle, sourcemap, and bytecode fixture

Two directories, `checkout-a` and `different-depth/checkout-b`, contained identical files:

```text
package.json
.env
src/server.ts
src/lib.ts
```

```json
{"name":"probe","module":"src/server.ts","type":"module"}
```

```ts
// src/lib.ts
export const message = "hello bunko";
```

```ts
// src/server.ts
import { message } from "./lib.ts";
console.log(message, import.meta.url, import.meta.dir, process.env.BUNKO_PROBE_VALUE);
```

The `.env` contained `BUNKO_PROBE_VALUE=dotenv-probe`. After normalizing cwd with realpath, each command ran twice in each checkout:

```sh
bun build ./src/server.ts --target=bun --root=. \
  --entry-naming=index.js --outdir=canonical-plain \
  --minify --env=disable

bun build ./src/server.ts --target=bun --root=. \
  --entry-naming=index.js --outdir=canonical-map \
  --minify --env=disable --sourcemap=external

bun build ./src/server.ts --target=bun --root=. \
  --entry-naming=index.js --outdir=canonical-bytecode \
  --minify --env=disable --bytecode
```

Fixed naming was suitable for this single-entry probe, but is not used for bunko's HTML-capable output tree.

| Output | Result |
| --- | --- |
| Plain `index.js` | 106 bytes; all four runs: `b2bbd37e5f8a265245651d7df58234c34850efd6c57124395962d8a5ef25f920` |
| Mapped `index.js` | 152 bytes; all four runs: `be95e3e2241048c87748440944b21c42d4c5114ef7e79d5cf60d8d4638e586f8` |
| Normalized `index.js.map` | 435 bytes; all four runs: `ea373b070a04f57912998dd8da4fac9167d760b6bfb25a1a0d70a474a9e2915b` |
| Bytecode `index.js` | 364 bytes in checkout-a, 396 in checkout-b; repeatable within each |
| `index.js.jsc` | 2.56 KB in checkout-a, 2.62 KB in checkout-b; repeatable within each |

Ordinary bundles retained `import.meta.url`, `import.meta.dir`, and the environment lookup as expressions. Bytecode's CJS wrapper replaced import metadata with absolute source-path strings. The generated JS established the cause; it was not a guess about timestamps or randomness.

The first sourcemap attempt mixed macOS `/var/...` and `/private/var/...` spellings in absolute output paths, producing different long relative `sources` entries. Normalized cwd/outdir yielded matching `../src/lib.ts` and `../src/server.ts` entries.

This does not establish determinism for arbitrary dependencies, Bun versions, OS/CPU combinations, compile, plugins, or macros. The environment probe only establishes that this fixture's value was not inlined.

## 4. HTML import fixture

```ts
// server.ts
import page from "./index.html";
Bun.serve({ routes: { "/": page } });
```

```html
<!doctype html><html><body><h1>probe</h1><script type="module" src="./client.ts"></script></body></html>
```

```ts
// client.ts
console.log("browser probe");
```

```sh
bun build ./server.ts --target=bun --outdir=out-default
```

This emitted `server.js`, `index.html`, and `index-428bmrtn.js`; the server's HTML manifest referenced the latter two. `--entry-naming=[name].[ext]` also succeeded.

```sh
bun build ./server.ts --target=bun --entry-naming=index.js --outdir=out
```

This exited 1 with `Multiple files share the same output path`, confirming that entry naming also affects HTML-derived outputs. It supports retaining HTML files in the app layer, but did not verify container HTTP serving. See [Bun's ahead-of-time HTML bundling documentation](https://bun.com/docs/bundler/fullstack#ahead-of-time-bundling-recommended).

## 5. Workspace lock and frozen install

The root declared `workspaces:["packages/*"]` and a dependency on `@probe/a` using `workspace:*`. Package a depended on workspace b; b had no dependencies.

```sh
bun install --lockfile-only --ignore-scripts
```

The resulting structure was:

```jsonc
{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "root", "dependencies": { "@probe/a": "workspace:*" } },
    "packages/a": {
      "name": "@probe/a",
      "version": "1.0.0",
      "dependencies": { "@probe/b": "workspace:*" }
    },
    "packages/b": { "name": "@probe/b", "version": "1.0.0" }
  },
  "packages": {
    "@probe/a": ["@probe/a@workspace:packages/a"],
    "@probe/b": ["@probe/b@workspace:packages/b"]
  }
}
```

This probe did not establish ordinary npm, catalog, patch, or peer-context formats. The root manifest was then changed to depend on b while the lock still referenced a:

```sh
bun install --production --frozen-lockfile --ignore-scripts
```

It exited 0 and left the mismatch intact, both in the original tree and in a fresh directory without copied node_modules. This narrow workspace-only result does not imply that frozen install accepts general npm dependency changes, or that reduced manifests can safely share arbitrary original locks. Bunko therefore preserves original manifests and validates their corresponding lock declarations itself.

## 6. Findings from official sources

| Topic | Confirmed scope |
| --- | --- |
| ko | Go build cache, reuse of existing Registry blobs, and KOCACHE's role. [Build Cache](https://ko.build/features/build-cache/) |
| Distroless Bun | The main-branch Dockerfile installs `/usr/local/bin/bun`; published-tag config had not yet been fetched. [Dockerfile](https://github.com/oven-sh/bun/blob/main/dockerhub/distroless/Dockerfile) |
| Install platform | Package selection using OS/CPU flags. [Bun install](https://bun.com/docs/pm/cli/install#platform-specific-dependencies) |
| Isolated installs | Store, symlinks, and peer contexts require consideration. [Bun isolated installs](https://bun.com/docs/pm/isolated-installs) |
| Cache config | OCI artifacts can use custom config media types. [OCI manifest](https://github.com/opencontainers/image-spec/blob/v1.1.1/manifest.md#guidelines-for-artifact-usage) |
| Distribution | Mounts, upload sessions, referrer fallbacks, and deletion have distinct contracts. [Distribution v1.1.1](https://github.com/opencontainers/distribution-spec/blob/v1.1.1/spec.md) |
| Provenance | The v1 predicate uses buildDefinition/runDetails. [SLSA provenance](https://slsa.dev/spec/v1.1/provenance) |

## 7. Initial outstanding validation

This is the pre-implementation checklist. Later sections record subsequent progress.

- [ ] Fetch exact-version distroless tags, indexes, platform manifests, and configs; record digests, User, Env, and libc.
- [ ] Run bundles on Linux amd64 and arm64; separately exercise custom bases and read-only root filesystems.
- [ ] Install target optional dependencies with scripts disabled and run representative native packages.
- [ ] Cover ordinary npm entries, duplicate versions, aliases, peers, catalogs, overrides, patches, and file/link/workspace forms.
- [ ] Verify HTML/CSS/file-loader/sourcemap placement in running images.
- [ ] Verify compile targets and dynamic linking; evaluate musl separately.
- [ ] Check tar/PAX/gzip golden bytes, compressed digests across hosts, and OCI schemas.
- [ ] Exercise real mount 201/202, credential helpers, referrers, and local exports.
- [ ] Maintain individual ECR/GAR/GHCR/Docker Hub/Harbor matrices; do not count untested cases as successes.
- [ ] Fix the buildx comparison configuration and measure upload/download bytes separately.

The design replaces the original proposal's requirement to finish every item before the initial prototype with gates for the features that depend on each result. Outstanding experiments are explicit implementation work.

## 8. Initial image composition validation

Implemented the TypeScript/Bun CLI, snapshots, bundling, deterministic tar/gzip, a public Registry reader, and OCI composition/layout. The original proposal moved to [archive/SPEC-v0.1.md](archive/SPEC-v0.1.md); [SPEC.md](SPEC.md) became the implemented contract.

### Automated checks

`bun run check` passed typechecking and unit/integration tests. Python tarfile independently inspected ordering, modes, uid/gid, mtime, PAX, long UTF-8 names, and link paths. Tests covered checkout depth, sourcemaps, HTML, asset reuse, corrupt base blobs, Bearer auth and redirects, config inheritance, stdout, and unsupported inputs.

`bun run build` produced a standalone CLI; `bun dist/bunko.js version` returned `0.0.1`. Linux/macOS CI configuration was added, but remote CI had not run during that stage.

### Published base and hello fixture

Fetched Docker Hub tag metadata, config, and layers, then pinned the hello fixture to the observed index:

| Item | Observed value |
| --- | --- |
| Base index | `oven/bun@sha256:6a78966e057efd546873b64d6c173b18a21a10c3da81562863beeaf044c1e2ec` |
| linux/amd64 base manifest | `sha256:13860e114310e8e7f9cbb7ca76d3a6cb0a505740c241521b56b8b329652b78a5` |
| Base User | `0`; hello explicitly overrides it with `65532:65532` |
| Bun path | Successfully started with `/usr/local/bin/bun` |
| Hello app layer | 293 gzip bytes for this small example |
| Hello index | `sha256:631ab3b2bf37977da809d378e5d0540b8698f65103c57446ded48d63ed36952a` |
| Repeated build | Layers/config/manifests/index matched with `--reproducible --verify-deterministic --git-metadata=false` |

These digests identify the validation snapshot, not future expected outputs after source, configuration, Bun, or bunko changes.

### Docker runtime

Loaded an OCI archive using a fully qualified test tag into Docker Engine 29.3.1's containerd image store. On the macOS arm64 host, `bun run test:smoke <hello-layout>` ran linux/amd64 and confirmed HTTP 200 with `Hello from bunko!\n`, user `65532:65532`, read-only rootfs, `/tmp:rw,noexec,nosuid`, all capabilities dropped, and SIGTERM exit 0. Test containers/tags were cleaned up.

This was not yet implementation of product `--local` or `--tarball`. OCI import used a fully qualified name and `io.containerd.image.name` annotation without changing ordinary build root bytes.

### Additional Bun 1.3.11 observations

- The macro fixture executed despite `--no-macros`, prompting pre-build rejection of import attributes/macros.
- CLI metafile outputs omitted external sourcemaps, requiring output-tree enumeration.
- Some nested sourcemaps resolved sources relative to outdir rather than the map directory; matching against metafile inputs allowed stable rewriting.

During initial composition, Registry publication/mounts, private credentials, native/npm dependencies, arm64 containers, and other Registry interoperability remained unimplemented or unverified.

## 9. Initial publication, build and cache validation

The same PR added private Registry authentication, push, production dependencies, deps/assets caching, multi-platform output, Docker archives, and Docker/kind loading. These results update the historical limitations in sections 7–8.

### Automated checks

Bun 1.3.11 typechecking and **86 tests / 264 assertions** passed. Ordinary tests use no Docker or network. Author-created npm download-cache fixtures exercise installation but do not replace real package download/integrity validation.

Coverage includes Docker credential precedence and aliases; GHCR/Hub/GAR scoped Bearer auth; ECR Basic refresh; OAuth identity tokens; mount 201/202/unsupported behavior; 429; redirect credential isolation; disconnected PATCH offset recovery; ambiguous manifest PUTs; partial tags; read-only dry-run; separate build/production installs; dev exclusion; disabled scripts; npm credential isolation; optional-peer lock validation; patch-sensitive keys; escaping links; ELF architecture; remote cache reuse without layer GET/upload; corrupt caches; cache write denial; determinism cache bypass; multi-platform indexes; and independent Python Docker-archive/DiffID inspection.

A separate real-package probe used `is-number@7.0.0`, the `num` alias, an optional peer, an override, and a `bun patch` patch. Bunko's isolated Linux production install retained patched bytes. The probe stalled in the initial sandbox but succeeded in the authorized execution environment. Offline tests cover lock consistency and patch-sensitive keys.

### Real Registry and Linux runtime

`bun run test:build-smoke` started a dedicated Distribution 3 container, built/published `examples/dependencies` for amd64/arm64 with local layer caching disabled, and verified independent deterministic builds. Editing the response string and publishing again produced Registry cache hits with zero deps/assets uploads.

| Item | Observed value |
| --- | --- |
| Host / tools | macOS arm64; Bun 1.3.11 revision af24e281; Docker Engine 29.3.1 |
| Base index | `oven/bun@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9` (Bun 1.3.11 slim) |
| Bundled JS | `is-number@7.0.0` |
| Native external | `@node-rs/xxhash@1.7.7`, prebuilt Linux addon, scripts disabled |
| Initial image index | `sha256:7913aacab58d9c1b3df0eef5dcfd483166fb442481a0796af9021c7ab1536abf` |
| Edited-source index | `sha256:bd589ee76439323cd2f680617a263a346e429ebb689eef8cd5b10dafc297305f` |
| Both platforms' HTTP | 200, `number:true`, `hash:510391394`, and the updated message |
| Runtime restrictions | User `65532:65532`, read-only rootfs, tmpfs /tmp, cap-drop ALL |
| Shutdown | SIGTERM exit 0 on amd64 and arm64 |

Docker Desktop's daemon could not directly pull from the host's published loopback port in this environment. Instead, the host Registry client fetched and verified manifests/layers, created a Docker archive, and loaded/reran it with Docker. This verifies real Registry push/pull and an independent container runtime, but does not claim successful direct Docker CLI pull. Dedicated Registry/container/tag resources were removed afterward.

### Transfers after a source edit

Unique blob payload bytes across both platforms:

| Kind | First publication | After source edit |
| --- | ---: | ---: |
| Base layers | 138,615,264 | 0 |
| Deps layers | 1,142,711 | 0 |
| Assets layer | 176 | 0 |
| App layer | 830 | 833 |
| Image configs | 9,441 | 9,441 |
| Total | 139,768,422 | 10,274 |

Compressed deps were 584,233 bytes for amd64 and 558,478 for arm64. Assets and this fixture's app bytes were shared. These are layer/config payloads, excluding manifests/indexes, cache metadata, HTTP overhead, and retransmission.

Recorded durations were 10,036 ms initially and 2,010 ms after the edit. **The first run built twice for determinism; the second built once; npm downloads were already cached.** These are not a fair performance comparison or evidence of superiority to buildx. Digests and sizes are historical fixture results.

### Docker and kind

Product `--local` generated, loaded, and inspected a single-platform Docker archive. Python checks its format/DiffIDs in ordinary tests.

After checking the official kind 0.33.0 macOS arm64 binary checksum, the probe created a temporary cluster. `--kind --kind-cluster ... --platform linux/arm64` loaded the image archive and passed node-side `crictl inspecti`. The cluster was deleted. This verified image storage, not native HTTP in a Kubernetes Pod.

### Compatibility fixes from real execution

- Use `--config=PATH`, `--registry=URL`, and `--cache-dir=PATH`; a space-separated config argument could be treated as another package by Bun 1.3.11.
- Use explicit HTTP readers because native async-iterator cleanup could throw; verify bytes by digest and size.
- Read bounded 8 MiB buffers for PATCH because file-backed Blob slices produced inconsistent transmitted bodies.
- The native fixture needed `libgcc_s.so.1`, absent from the distroless base. Switch it to slim and require explicit native-runtime bases. Although both glibc/musl variants may install, only glibc was run.

### Outstanding interoperability and performance work

Live GHCR/GAR/Docker Hub/ECR publication, real private npm authentication, and provider-specific mounts were not verified. See [REGISTRIES.md](REGISTRIES.md). HTML container serving, arbitrary native ABI compatibility, musl, other Bun versions, repeated benchmarks, and buildx comparisons remained untested.

CI runs typechecks, unit/integration tests, and bundled CLI checks on Linux/macOS, plus real Distribution smoke on Linux. Smoke builds both architectures but runs amd64 on Linux CI; the local record includes both architectures.

## 10. Workspace validation

Added shared-lock validation, automatic/explicit workspace target selection, multiple-image build/publication, and production-runtime topology preservation.

### Automated checks

Typechecking and **97 tests** passed on Bun 1.3.11, retaining the earlier 86 build/cache tests. Added root/member discovery, name/path selectors, shared packages with distinct fixture-msg 1.0.0/2.0.0 versions, peer resolution for fixture-adapter, Python layer extraction and Bun execution, external workspace TypeScript/data, root-relative tsconfig extends, checkout-depth determinism, service-source cache hits, runtime-workspace cache misses, stale manifests/membership/lock entries, image-name conflicts, escaping links, asset collisions, delayed-build failure before export/publication, multi-target dry-run, partial reports, stdout, single-target tarball restrictions, and report/layout collision validation.

Author-created packages live in isolated download-cache fixtures. Bunko inspects Bun's actual installed store and symlinks instead of reimplementing semver resolution.

### Real Registry, CLI, and runtime

`bun run test:workspace-smoke` ran on macOS arm64 / Bun 1.3.11 / Docker 29.3.1. The CLI published two multi-platform images to dedicated Distribution 3; stdout contained exactly two digest lines in target order. Initial outputs matched across independent staging builds.

| Target | Shared package | npm dependencies | Linux runtime |
| --- | --- | --- | --- |
| api | Bundled @example/shared | is-number 7.0.0; external @node-rs/xxhash 1.7.7 | amd64/arm64: HTTP 200, version 7.0.0, hash 510391394 |
| worker | External @example/shared with JSON data | External is-number 6.0.0 | amd64/arm64: HTTP 200, version 6.0.0 |

The base was the same previously validated slim index, `oven/bun@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9`. All four runtime combinations passed nonroot `65532:65532`, read-only rootfs, tmpfs /tmp, cap-drop ALL, and SIGTERM exit 0.

An API response edit produced Registry deps cache hits and zero deps uploads for both targets/platforms. Worker app uploads were also zero; its config changed because the source digest covers the whole workspace. New layer/config payloads were 9,552 bytes for api and 9,167 for worker, excluding metadata and HTTP overhead. This fixture had no assets layer; ordinary tests covered asset reuse.

As in the earlier build/cache validation, verified host-side Registry pulls were loaded through Docker archives; this was not direct Docker CLI pull validation. Temporary resources were cleaned up. CI added workspace smoke, building both architectures and running both services on amd64; local testing ran all four combinations.

### Optimizations deferred during initial workspace support

The initial workspace implementation retained the whole workspace production tree, including API-only native dependencies in the worker. Closure reduction, sharedDeps, focused cache keys, and narrower source digests were future work at that point. Section 11 records the first three; whole-workspace source digests remain the contract.

## 11. Dependency closure and sharedDeps (2026-09-07)

`bun run test:closure-smoke` passed on Bun 1.3.11 / macOS arm64 / Docker Desktop. It published two targets for amd64/arm64 to real Distribution, verified edited-source Registry hits and zero extra deps/assets uploads, excluded the API-only native addon from the worker closure, and produced identical per-platform deps digests across targets with sharedDeps.

Eight target/platform combinations across separate and shared closures passed verified RegistrySource pull, Docker archive/load/run, native xxhash, distinct is-number 7/6 behavior, shared workspace JSON, nonroot/read-only operation, and SIGTERM exit 0. Independent Linux installs also produced deterministic initial closures. CI added the same smoke with amd64 runtime execution.

Ordinary tests cover duplicate versions/peer contexts, bundled-workspace exclusion, missing optional/required dependencies, escaping links, executable aliases, package data, checkout depth, cache hits after unrelated dev-lock changes, and misses after reachable workspace edits. Closure cache hits still perform Linux installation; no install avoidance or speedup is claimed. Live cloud Registry status remained as recorded in the earlier build/cache validation.

## 12. Manifest resolution (2026-09-07)

`bun run test:resolve-smoke` passed on macOS arm64 / Bun 1.3.11 / Docker Desktop. Real CLI resolve processed two YAML documents with anchors/aliases and matched output scalars to published references for two services on amd64/arm64. Aliases did not create extra targets; comments were retained. Edited-source Registry reuse and all eight separate/shared closure runtime checks passed, including native addons, distinct dependency versions, nonroot/read-only operation, and SIGTERM exit 0.

Ordinary tests cover YAML documents/comments/block scalars/CRLF/complex keys/anchors/aliases, template and partial-string exclusions, exact JSON numeric bytes, multiple-JSON arrays, directory ordering/recursion, stdin, canonical deduplication, workspace sharedDeps, pre-publication syntax/name/build failures, changed target identity, partial-publication reports, empty failure stdout, and YAML 1.1/1.2 directive boundaries.

`bun run build && bun run test:bundled-smoke` copied only dist/bunko.js to a temporary directory without external node_modules, then verified stdin resolve and the bundled YAML license. CI added bundled and real-Registry manifest resolution smoke. These results do not include kubectl apply or individual cloud Registry live publication.
