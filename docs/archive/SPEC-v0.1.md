# bunko — Original proposal v0.1

This is an English translation of the original proposal, retained for design history. It includes assumptions and features that were later revised or deferred. The current contract is [SPEC.md](../SPEC.md), with decisions in [DESIGN.md](../DESIGN.md). The [original Japanese text remains in Git history](https://github.com/sakajunquality/bunko/blob/337ee98666025212849f2b38c432f3e38174048f/docs/archive/SPEC-v0.1.md).

Bunko builds OCI images from Bun projects without Dockerfiles or a daemon. It adapts ko's Go-oriented approach—the toolchain produces artifacts, and only changed layers are pushed—to Bun, using the Registry itself to provide functionality comparable to buildx's Registry cache.

The original proposal designated this document as the sole implementation specification. It required contradictions and undefined behavior to be added to an open-questions section, then reflected in the relevant sections once resolved. The current documents linked above supersede that instruction.

## 1. Goals and non-goals

### Goals, in priority order

1. **Zero configuration:** `bunx bunko build .` works from package.json alone.
2. **Minimal incremental push:** a one-line change uploads only the application bundle layer, from a few hundred KB to a few MB.
3. **Deterministic builds:** identical source, lockfile, and bunko version produce identical image digests.
4. **Daemonless:** no Docker daemon or BuildKit, with identical local and CI behavior.
5. **Workspaces:** build multiple images from one bun.lock and share dependency layers between services.
6. **Supply-chain metadata:** attach SBOM, provenance, and signatures with one option.
7. **Alternatives for special cases:** compile mode, externally prepared native dependencies, and arbitrary base images.

### Non-goals

- Interpreting Dockerfiles or executing arbitrary RUN instructions.
- Building Node.js projects; v0 targets Bun, with future support left open.
- Windows containers.
- Implementing or hosting a Registry.

### Benchmark proposal

The original proposal called for a benchmark at the top of the README to substantiate its performance claims. Compare the official Bun multi-stage Dockerfile using compile with buildx and `--cache-to type=registry`. Measure bytes pushed after a one-line change, build time with cache hits, image size, and digest reproducibility. Keep reproduction scripts in `bench/` and update them for each release.

## 2. Terms

| Term | Meaning |
| --- | --- |
| target | One package to build: the root for standalone projects, or a workspace package |
| platform | An OCI platform such as linux/amd64 or linux/arm64 |
| layer | A gzip tar OCI layer, ordered by role |
| cache key | SHA256 of layer inputs, associated with a Registry cache tag |
| bundle mode | Default mode: place JS emitted by `bun build --target=bun` in the app layer |
| compile mode | Place the single binary emitted by `bun build --compile` in the app layer |

## 3. CLI

```text
bunko build [<path>...]       Build and push images by default
bunko resolve -f <file>...    Replace bunko:// references with image digest references
bunko apply -f <file>...      Resolve and pipe to kubectl apply (operations)
bunko cache ls|prune         List or remove Registry cache tags
bunko version
```

### Proposed build interface

```text
bunko build [<path>...] [flags]

  <path>             Target directory; defaults to ".". A workspace root builds
                     all targets. Also accepts bunko://<path>, as resolve does.
  --repo <ref>       Destination; defaults to BUNKO_REPO
  --push             Push by default; --push=false produces a tarball only
  --local            Load into Docker using bunko.local
  --kind             Load into kind using kind.local and KIND_CLUSTER_NAME
  --platform <list>  Comma-separated platforms; defaults to linux/amd64
  --tag <t>          Repeatable; defaults to latest plus the Git short SHA
  --bare             Use <repo> directly instead of <repo>/<target-name>
  --mode bundle|compile
  --base <ref>       Override the base image
  --sbom             Publish an SPDX SBOM referrer; defaults to true
  --sign             Execute cosign to sign the image
  --oci-layout <dir> Also write an OCI layout directory
  --tarball <file>   Write a Docker-loadable archive
  --verbose / -v
  --dry-run          Show what would be pushed
```

Stdout contains one final `repo/name@sha256:...` reference per line. Logs go to stderr, allowing output to feed tools such as kubectl set image, as with ko.

### Environment variables

| Variable | Proposed meaning |
| --- | --- |
| `BUNKO_REPO` | Default push destination; overridden by --repo |
| `BUNKO_DEFAULT_BASE` | Default base image |
| `BUNKO_DEFAULT_PLATFORMS` | Default platforms |
| `SOURCE_DATE_EPOCH` | Layer mtime and image creation time; defaults to 0 |
| `BUNKO_CACHE_REPO` | Cache repository; defaults to <repo>/bunko-cache |
| `BUNKO_DOCKER_CONFIG` | Docker config.json file; defaults to ~/.docker/config.json |

## 4. Configuration in package.json

Use only the `bunko` key rather than adding a configuration file. All fields are optional.

```jsonc
{
  "name": "api",
  "module": "src/server.ts",
  "bunko": {
    "entrypoint": "src/server.ts", // Default: bin, then module, then main
    "mode": "bundle",             // bundle or compile
    "base": "oven/bun:1-distroless", // See section 6.1
    "platforms": ["linux/amd64", "linux/arm64"],
    "assets": ["public", "migrations"], // Files/directories or globs to copy
    "external": ["sharp", "@prisma/client"], // Put these in deps instead of bundling
    "env": { "NODE_ENV": "production" },
    "ports": [3000],
    "user": "65532:65532", // Inherit base User; use nonroot if unset
    "workdir": "/app",
    "labels": { "org.opencontainers.image.source": "https://github.com/..." },
    "args": [], // Arguments after the entrypoint
    "build": { // A subset of bun build options
      "minify": true,
      "sourcemap": "external", // none, inline, or external
      "bytecode": false,
      "define": { "process.env.FOO": "\"bar\"" },
      "target": "bun"
    }
  }
}
```

Entrypoint discovery order: bin (string or single entry), module, main, src/index.ts, index.ts. Fail if nothing is found.

The proposed automatic external detection would merge these with explicit externals:

- Packages containing `.node` files under node_modules.
- Packages listed in trustedDependencies.
- @prisma/client and prisma, which require engine files.
- Packages reported as unresolved by bun build, with one automatic externalization retry and a warning.

## 5. Build pipeline

```text
Resolve targets
  For workspaces, read the package list from bun.lock
For each target:
  1. Fetch base manifest/config for each platform
  2. Deps: H(relevant lock entries, externals, platform), then cache lookup
  3. Assets: H(asset files), then cache lookup
  4. App: run bun build, create deterministic tar, compute digest
  5. Compose config: entrypoint/env/user/labels/created
  6. Compose platform manifests and an index for multiple platforms
  7. HEAD blobs, then upload missing blobs or mount cache hits
  8. Attach SBOM/signatures
  9. Print digest references
```

The proposal described each step as a pure function and required dry-run to stop before step 7.

## 6. Layer format

The order is fixed, with more frequently changing content higher in the image.

| Order | Layer | Contents | Destination | Cache |
| --- | --- | --- | --- | --- |
| 0 | base | Unchanged base-image layers | Existing paths | Already in Registry |
| 1 | deps | External node_modules and transitive dependencies | /app/node_modules | Registry cache |
| 2 | assets | Selected files | /app/<original-relative-path> | Registry cache |
| 3 | app | index.js and maps, or compiled binary | /app | Recompute; check existence with HEAD |

Omit empty layers rather than adding empty tar archives.

### 6.1 Base image

Proposed default: `oven/bun:1-distroless`, subject to existence/content checks in section 11. Pin the resolved digest and label the config with `org.bunko.base.digest`. Resolve tags each build to follow base updates; users can configure a digest for an immutable base.

Bundle mode requires Bun at `/usr/local/bin/bun`. Compile mode requires glibc and libstdc++, with `gcr.io/distroless/cc-debian12` proposed as its default. Evaluate the bun-linux-x64-musl target in supply-chain and compile.

### 6.2 Dependency layer

1. Parse JSONC bun.lock and compute the transitive closure from externals.
2. Copy an external-only package.json with lock-pinned versions and bun.lock into a temporary directory; run `bun install --production --frozen-lockfile`. If frozen install fails, fall back to a full install and remove packages outside the closure.
3. Fetch platform optional dependencies using `bun install --os linux --cpu <arch>`, subject to section 11 validation. Otherwise install on a native target host or delegate to BuildKit.
4. Pack node_modules deterministically.

Proposed key: SHA256 of normalized closure lock entries, platform, and Bun major version.

### 6.3 App layer in bundle mode

```sh
bun build <entrypoint> --target=bun --outdir=<tmp> [--minify] [--sourcemap=...] [--define ...] \
  --external <each-external> --packages=bundle
```

Rename the output entry to index.js regardless of its input name. Include HTML-import assets emitted by Bun unchanged. A hidden `--verify-deterministic` flag builds twice and compares digests, and must run in bunko's CI tests.

### 6.4 App layer in compile mode

```sh
bun build <entrypoint> --compile --target=bun-linux-<arch> --outfile=<tmp>/app [--minify] ...
```

Build a separate layer per platform. Recheck determinism with bytecode enabled; this was unverified. Warn about the larger output and suggest considering bundle mode.

### 6.5 Deterministic tar

- Sort paths by UTF-8 bytes and include parent directory entries before children.
- Set mtime to SOURCE_DATE_EPOCH, default 0; omit atime/ctime.
- Use uid/gid 0 and empty user/group names.
- Use 0755 for directories/executable files and 0644 otherwise.
- Omit xattrs and PAX unless required for oversized fields; store symlinks without resolving them.
- Set gzip mtime 0, no filename, OS byte 255, and compression level 6.
- Keep /app owned by root, even for another runtime user; use /tmp for writes.

Compute both the uncompressed SHA256 DiffID and compressed digest, and populate rootfs.diff_ids with layer DiffIDs.

### 6.6 Config

The original illustrative structure was:

```text
architecture: <arch>
os: linux
created: <SOURCE_DATE_EPOCH formatted as RFC3339>
config:
  Entrypoint: ["bun", "run", "/app/index.js"]  # Compile: ["/app/app"]
  Cmd: <args>
  Env: ["PATH=<base PATH>", "NODE_ENV=production", ...]
  WorkingDir: /app
  User: <user>
  ExposedPorts: {"3000/tcp": {}}
  Labels:
    org.opencontainers.image.created: ...
    org.opencontainers.image.revision: <Git SHA>
    org.bunko.version: ...
    org.bunko.base.digest: sha256:...
    org.bunko.mode: bundle
rootfs: {type: layers, diff_ids: [...]}
history: [<base history>, {created_by: "bunko deps"}, ...]
```

Inherit base Env, User, and WorkingDir, then apply bunko overrides.

## 7. Registry cache

The proposal aimed to provide buildx-like Registry caching using only Registry content addressing.

### 7.1 Cache tags

Use BUNKO_CACHE_REPO, defaulting to <repo>/bunko-cache. Tags are `k-<first-32-key-hex-characters>`. Each is a minimal one-layer manifest with an empty JSON config and annotations `org.bunko.cache.key`, `org.bunko.cache.kind` (deps/assets), and `org.bunko.cache.created`.

### 7.2 Lookup and hits

1. HEAD `/v2/<cache-repo>/manifests/k-<key>`; on 200, GET its layer digest.
2. POST `/v2/<repo>/blobs/uploads/?mount=<digest>&from=<cache-repo>`; 201 completes without transfer.
3. If mounting returns 202, GET the cached blob and PUT it to the destination.

The original proposal said that a hit skips bun install and ignores local node_modules.

### 7.3 Misses

Build and push the layer, mount its digest into the cache repository, and PUT the cache tag. A failed cache-tag PUT produces a warning rather than failing the build.

### 7.4 Pruning

`bunko cache prune --older-than 30d` uses the created annotation to select tags for DELETE. On Registries without deletion support, list the candidates and explain the limitation.

### 7.5 Local cache

Store digest-named blobs and a key-to-digest index under ~/.cache/bunko. Check it before the Registry; disable it with --no-local-cache. The original proposal left Bun's global ~/.bun/install/cache outside bunko's control.

## 8. Multiple platforms

- Treat bundle-mode app and asset layers as platform-independent: build once and share across manifests.
- Include platform in dependency keys. Identical resulting bytes still share one blob digest.
- Select platform manifests from the base index.
- Emit an OCI image index, including for one platform; --no-index produces a single manifest.
- Require no QEMU. Delegate dependencies needing native compilation as described next.

## 9. Alternatives for special cases

### 9.1 BuildKit delegation for native dependencies

Bunko cannot build packages that need node-gyp or similar compilation. The proposed `--deps-from <image-ref>` takes the top layer of an externally built node_modules image as its deps layer, computes the usual key, and registers it in the cache. Provide a buildx Dockerfile and Action example under examples/native-deps.

### 9.2 Compile mode

Use the compile mode described above to build bunko's own distributable binary.

### 9.3 Arbitrary bases

Allow arbitrary base references. Before startup in bundle mode, inspect config PATH and layers for /usr/local/bin/bun and warn if absent.

## 10. Workspaces

- A root package.json with workspaces enables workspace mode.
- `bunko build .` builds packages with bunko configuration; if none have it, use packages with bin or module.
- Allow explicit paths such as `bunko build ./apps/api ./apps/worker`.
- Compute each target's dependency closure independently; identical contents share digests. Root `bunko.sharedDeps:true` requests a common layer for all targets in workspace and resolution.
- Run bun build with the target directory as cwd and bundle internal workspace packages.

## 11. Open questions before implementation

- [ ] Check oven/bun:1-distroless, Bun's path, and default User/Env.
- [ ] Compare repeated bun build output, hashed filenames, import.meta expansion, and possible timestamps.
- [ ] Verify bytecode determinism.
- [ ] Verify install OS/CPU flags and platform optional dependencies.
- [ ] Inspect the JSONC lock schema for workspaces, catalogs, and patchedDependencies.
- [ ] Inspect HTML-import output and static asset placement.
- [ ] Evaluate musl and whether a static distroless base is suitable.
- [ ] Test blob mounts on ECR/GAR/GHCR/Docker Hub/Harbor and the section 7.2 fallback.

## 12. Implementation

### 12.1 Language and distribution

Use TypeScript on Bun, with zero runtime dependencies and development dependencies allowed. Distribute through npm for bunx and as a compiled single binary on GitHub Releases. Support the latest Bun minor available at implementation start and record the range in engines.bun.

### 12.2 Proposed repository layout

```text
bunko/
  packages/
    oci/                 # Reusable library independent of bunko
      registry.ts        # Distribution auth, blobs, mounts, manifests, referrers
      auth.ts            # Docker config, helpers, stores, Bearer flow
      tar.ts             # Deterministic tar/gzip and DiffID
      digest.ts
      types.ts           # Manifest/index/config types
      layout.ts          # OCI layouts and Docker archives
    bunko/
      cli.ts
      config.ts          # package.json configuration and discovery
      lockfile.ts        # Lock parsing and closure computation
      layers/{deps,assets,app}.ts
      cache.ts           # Registry and local caches
      build.ts           # Pipeline
      resolve.ts
      sbom.ts
  bench/
  examples/{hello,fullstack,workspaces,native-deps,compile}/
  test/
    unit/
    e2e/                 # registry:2 container or an in-memory implementation
  docs/
    SPEC.md
    LAYERS.md            # External layer/cache format and upstream proposal
```

### 12.3 Tests

Unit-test packages/oci against an in-memory test/fake-registry.ts with supported and unsupported mounts. Build examples twice and compare every digest. E2E tests build, pull, and run through registry:2, optionally in CI. bench/run.sh reports the four metrics from section 1.

### 12.4 Errors

Fail instead of guessing when the entrypoint is unknown, Bun is absent from the base, or the required bun.lock is missing. Unsupported mounts/referrers/DELETE use fallbacks or warnings. Forward Bun subprocess stderr unchanged.

## 13. Supply-chain metadata

- Generate SPDX 2.3 JSON from bun.lock and reference any base SBOM referrer. Push through OCI 1.1 referrers, falling back to a `sha256-<digest>.sbom` tag.
- Emit minimal SLSA v1 provenance with bunko@version as builder and Git SHA, lockfile digest, and base digest as materials, using the terminology of the original proposal.
- Execute `cosign sign` for --sign rather than implementing signatures internally.
- Record the pinned base digest label; proposed supply-chain and compile `bunko build --check-base` reports available base updates.

## 14. Resolve

Find bunko://<path> strings in YAML/JSON, build each target, replace them with repo/name@sha256 references, and emit stdout. The original proposal called for parallel builds and assumed equal cache digests would make races harmless. Support stdin via -f - and a directory's *.yaml through -f dir/. Use shell process substitution such as `bunko resolve -f <(helm template ...)` rather than dedicated Helm/kustomize integration.

## 15. Original milestones

| Milestone | Scope | Proposed completion criteria |
| --- | --- | --- |
| initial prototype | OCI auth/blobs/manifests/tar, bundle mode, push | bunx builds hello for Cloud Run/Kubernetes; determinism tests pass |
| build and cache | Registry/local cache, multiple platforms, local/kind | README benchmarks; a one-line edit uploads only the app layer |
| workspace and resolution | Workspaces, sharedDeps, resolve | Three example services share dependencies |
| supply-chain and compile | SBOM/provenance, signing, base checks, compile, musl evaluation | Publish a GitHub Action |
| operations | Apply, cache prune, deps-from, HTML fullstack example | Publish LAYERS.md as an upstream proposal |

The original proposal required completing every section 11 experiment before initial prototype and recording the results there. The later detailed design changed this sequencing.

## 16. Original design rationale

- Bundle is the default because compile embeds roughly 60–90 MB of Bun runtime in a changed layer, while a bundle changes only JS.
- Registry caches avoid per-CI cache configuration; mounts can eliminate blob downloads/uploads. The original assertion that buildx must pull its Registry cache was a hypothesis, not a measured result.
- TypeScript serves Bun developers through bunx and allows the OCI client to become a reusable library.
- Keeping configuration in package.json avoids adding another project configuration file.
- When entrypoint or external detection cannot decide, stop for an explicit decision, following the intended ko-like experience.
