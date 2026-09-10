# Cache distribution and retention

Bunko caches use its own OCI artifact format. They are not BuildKit cache records. Native/generated dependency keys retain platform and base compatibility inputs; this change does not introduce rebase or relax those constraints.

```sh
bunko build . --repo registry.example/team/app \
  --cache-from registry.example/team/main-cache \
  --cache-from registry.example/team/shared-cache \
  --cache-repo registry.example/team/branch-cache
```

Reads try the local cache, each `--cache-from` in order, then `--cache-repo` (the output repository by default when pushing). A denied, missing or corrupt cache source falls through to the remaining sources and then rebuilding. Every accepted layer is checked against its compressed digest and uncompressed DiffID. Reports identify the successful registry or local source and whether a final miss involved unavailable or invalid data.

Registry cache writes use an explicit `--cache-repo` and any `--cache-to` destinations. Without an explicit `--cache-repo`, `BUNKO_CACHE_REPO` or `--cache-to`, no registry cache is written. This changes the implicit-write behavior of 0.3.2 and earlier; managed local caching and legacy image-repository reads remain enabled. They occur after successful build validation and, when requested, image publication. Explicit `--cache-repo` and `--cache-to` destinations also export when `--push=false`; dry-run and offline builds never export remote caches. Hits from another read repository are eligible for promotion to that destination. `--cache-write=false` keeps reads and disables explicit exports and registry cache writes; local persistence remains controlled by `--local-cache=false`. `--cache=false` disables both caches and cannot be combined with explicit `--cache-from`/`--cache-to` locations.

```sh
bunko cache-info --cache-dir ./cache
bunko prune --cache-dir ./cache --keep-bytes 1073741824
bunko prune --cache-dir ./cache --keep-bytes 1073741824 --execute
```

Closure builds also store small `plans/deps` index records that map a pre-install closure plan key to the content key of the closure layer it produced. They own no blobs, are validated and counted like key metadata, and are deleted with the `deps` record they name; their bytes are credited to the budget as that record is selected, so an attached plan never causes an extra layer to be evicted. A plan is written only after the record it names is reconfirmed under the same cache lock, and a plan that names no record is reclaimed before any budget selection, so neither a concurrent prune nor a sweep leaves an index entry pointing at a reclaimed layer.

Every build also stores one small `base-inspect/<inspection-version>/<base digest>.json` record per inspected base, holding the filesystem tree that base yielded. Like plans they own no blobs, and they are validated and counted like key metadata, but nothing references them and they reference nothing: they are ordinary oldest-first budget candidates, and reclaiming one only costs the next build another inspection. A record written under a superseded inspection version can never be read again and is reclaimed before any budget selection.

## Closure plan artifacts in a registry cache

The same plan records are published to the registry cache, so a runner with an empty local cache reaches the warm closure path from the cache repository instead of re-running the install and the projection. They are ordinary Bunko cache artifacts with a distinct tag prefix:

```
bunko-cache-v1-deps-plan-<full plan key>    closure plan index (no layer)
bunko-cache-v1-deps-<full content key>      the closure layer a plan names
bunko-cache-v1-{assets,app,runtime}-<key>   the other layer artifacts
```

A plan artifact uses the `application/vnd.bunko.cache.v1` artifact type, the OCI empty descriptor (`application/vnd.oci.empty.v1+json`) as its single layer, and an `application/vnd.bunko.cache.plan.config.v1+json` config blob holding the plan record; its manifest annotations carry `org.bunko.cache.key`, `org.bunko.cache.kind: deps-plan`, `org.bunko.cache.plan.layout` and `org.bunko.cache.pack.format`. Because a plan owns no blob it costs a few kilobytes of metadata per plan key, and a changed lock, manifest, Bun revision, base digest, platform or pack format produces a new tag rather than replacing one.

Reads try the local `plans/deps` index first and then the ordered registry sources; a hit is written through locally after the layer it names is durable. A candidate counts as a hit only once the build can use it, so a source whose plan names a missing closure layer falls through to the next source instead of ending the lookup; each closure layer key is resolved once per lookup, so several sources naming the same layer cost one lookup, not one each. `--no-cache` and `--no-local-cache` consult no plan from any transport: the managed local cache is where a hit is written through, and both flags exist to force a clean local flow.

Writes follow the layer rules: a registry cache write destination is required, `--cache-write=false` suppresses them, dry-run and offline builds skip them, and a plan is published only after the `deps` record it names was seen at that destination during the same build. That ordering is not a distributed guarantee — a prune between the two passes can leave an index whose layer is gone — and readers handle that as an ordinary miss. Failures are reported in `cacheExports` with kind `deps-plan` and warn by default. Explicit `--cache-from type=local` / `--cache-to type=local` locations carry layer records only; plan indexes live in the managed local cache and in registry caches.

`bunko prune --cache-repo REPO` enumerates plan tags with the same ownership checks it applies to layer tags — the tag, artifact type, config media type and the plan key recorded inside the config must all agree — and deletes them under the same tag-only deletion rules, previewing unless `--execute` is given. Plan artifacts are listed in `tags` alongside layer artifacts. Deleting a plan tag only removes an index; the closure layer it named survives until its own tag is deleted, and a build that finds no plan simply installs and projects again. Provider retention or lifecycle policies that expire tags by age treat plan artifacts like any other cache tag, so no separate rule is needed; expiring a `deps` layer while its plan survives is harmless, because a plan is honoured only once the layer it names resolves.

The byte budget covers validated key metadata plus its unique referenced blobs. Unknown files, unreferenced CAS objects, temporary files, lock metadata and filesystem overhead are excluded and untouched. This is a managed-byte budget, not a bound on total directory disk usage.

Budget pruning chooses the oldest metadata modification time first with a deterministic key tie-break. It is not access-time LRU. Shared blobs are counted once and retained until every selected reference is removed. `--older-than` remains available for age-based retention and cannot be combined with `--keep-bytes`. Both modes preview by default. Only `--execute` deletes; validation and the cache lock precede deletion. There is no automatic build-time GC. Bun's package download cache (`--install-cache`, by default `${XDG_CACHE_HOME:-~/.cache}/bunko/install/v1`) and the verified runtime download cache are separate directories outside this budget; `cache-info` and `prune` do not manage them, so reclaim their space directly.

Remote pruning remains provider-dependent tag-only deletion. No generic remote byte-budget claim is made.

## Optimization scope

Repeated builder measurements and CI workflows justify reusable read sources and explicit local retention. Finer scheduling, automatic base rebasing, remote workers and distributed tracing remain deferred. The benchmark is exploratory workstation evidence, not a general ranking against BuildKit; see [Build comparison](BUILD_COMPARISON.md).

## Trust and operational limits

Every read cache and its writers must be trusted as much as the build inputs. A closure plan record is part of that boundary, and a plan from a registry is trusted neither more nor less than a local one.

What a plan record can do, from either transport: name which already-validated `deps` cache record this build reuses, and supply the metadata replayed from it — target aliases, package sizes and paths, the omitted-addon count, and undeclared/optional-import findings. A writer who controls the local cache directory or a read cache repository can therefore point a plan at a different closure layer, which is exactly the capability of supplying that layer's contents directly, and can influence what the closure summary and the import diagnostics report. That is why a cache that supplies plans needs the same trust as one that supplies layers.

What a plan record cannot do: make the build read anything outside validated cache records, or fail the build. It is honoured only after the `deps` record it names resolves and validates on its own, so a plan naming a layer nobody has is a miss. It is validated against the expected plan key, destination and platform, and its replayed aliases are held to the same path, collision and symlink rules layer packing applies — relative targets that stay inside the layer, no control characters, no duplicate or case-colliding paths — so a record that could not be packed is rejected while the build can still reproject, rather than raising an exception once the closure has been accepted. Validation rebuilds the record from the fields it checked rather than passing the parsed document through, so an unvalidated extra field is never replayed, written to the local index or republished, and cannot be made large or deeply nested enough to fail serialisation after the plan has been accepted. A stalled response body is bounded by the same idle timeout blob transfers use, so a source that answers and then stops sending becomes a miss and the next source is tried. Every rejection is a miss with a reason recorded in the report. Validation proves the record is internally consistent and usable; it does not prove that a trusted producer wrote it, and it does not constrain the *contents* of the layer a plan names, which the trusted-cache-writer model governs. A digest and DiffID prove content integrity and internal consistency; they do not prove that a producer built the layer from the claimed cache inputs. A malicious cache writer can supply application/dependency contents and inventory, and promotion preserves that content in the write destination. Producer signature verification for prepared dependencies does not authenticate application caches. Use isolated trusted cache repositories, or disable caches when that trust cannot be established. The CI policy does not elevate cache trust.

A base inspection record is also a trusted local input: a writer who controls the directory can make workdir, data-destination and runtime-placement checks reason about a base other than the pinned one. Base inspection records are read only from the local cache; closure plans can also be read from configured trusted registry sources.

Accepted registry hits are persisted locally only after build/determinism checks succeed. Cache metadata has an 8 MiB limit for writes and reads; larger records are not cached. Existing oversized or malformed local records require manual investigation before pruning.

Usage and preview operations take the same exclusive lock as deletion to provide a consistent snapshot. They require a writable cache directory and can wait for a writer; a read-only cache mount can still supply build hits, but cannot provide locked usage/prune queries. Lock files are temporary and are not included in managed usage.

Bun's extracted package download cache is trusted build input. Reusing an entry does not independently reverify its package integrity. Keep it private to the intended trust domain and never restore a cache writable by untrusted pull requests into a trusted publishing build. Use `--no-local-cache` without an explicit `--install-cache` to retain per-build temporary staging.

Prune results list layer key records as `<kind>/<digest>.json` and closure plan records as `plans/deps/<digest>.json` in `keys`. Cache events describe lookup attempts. Every closure build now records a `deps-plan` entry whose status is `local`, `registry`, `miss` or `bypass`, in local-only builds as well — it is the one report change a build with no registry cache sees. It describes the closure index rather than a layer, so anything that aggregates layer reuse rates should exclude it; an invalid or unavailable closure plan may be followed by a lookup of the newly projected content key.

Orphaned closure plans and plans using an obsolete layout or pack format are reclaimed before age or byte-budget selection. Their dependency layers remain available unless those layer records are independently selected for pruning.

## Export outcomes and immutable repositories

`cacheExports` in build reports records each attempted export's backend, destination, kind (a layer kind or `deps-plan`), key, status, transferred bytes and duration. Local byte counts measure bytes written, including replacement of existing blob files; registry counts measure uploaded bytes. Status is `written`, `already-present` or `failed`; failures distinguish conflicting output, invalid existing data, denied access, timeout and unavailability. A failed cache export warns by default. Use `--cache-export-error=fail` for strict cache-warming jobs. A strict error does not undo image publication; the failure report retains the published reference and export outcomes.

Cache tags are derived from input keys. Existing identical records are reused without retagging. After a concurrent immutable-tag refusal or uncertain write, Bunko reconciles the winning record once, checking metadata, layer digest and DiffID. Different results for the same key are reported as conflicts and never accepted as successful cache writes.

Prefer separate release and cache repositories, with appropriate writer permissions and provider cleanup policies. Unique cache tags avoid moving-tag updates but do not guarantee reclaimable storage: Artifact Registry cannot delete tagged artifacts while tag immutability is enabled. Bunko never changes repository policies. Live private-provider immutability/retention validation is separate from the mocked concurrency checks.

OpenTelemetry includes cache export counts, transferred bytes and duration histograms with bounded backend/kind/result/reason labels. Repository names and cache keys are kept out of metric labels.

Strict export mode rejects offline and dry-run builds. Local persistence failures do not disable registry exports. A reconciled concurrent write reports `already-present` with `reconciled: true`; `bytes` still includes any bytes uploaded before reconciliation. Missing referenced blobs are reported as `invalid`.


## Typed storage locations

```sh
bunko build . --repo registry.example/team/app \
  --cache-from type=registry,repo=registry.example/team/main-cache \
  --cache-from type=local,src=./restored-cache \
  --cache-to type=registry,repo=registry.example/team/branch-cache \
  --cache-to type=local,dest=./exported-cache

bunko build . --push=false --oci-layout ./image \
  --cache-to type=local,dest=./exported-cache \
  --cache-export-error=fail
```

The default managed local cache is checked first, followed by up to 32 supplied `--cache-from` values in order, then the legacy cache repository. Bare repository values are accepted for both `--cache-from` and `--cache-to`. `--cache-to` accepts up to eight supplied destination values and is write-only: add the same location to `--cache-from` when reuse is wanted. Duplicate normalized locations are processed once. There is no implicit image-repository write destination. Explicit destinations retain legacy image-repository reads and supplement an explicitly configured `--cache-repo` or `BUNKO_CACHE_REPO`; use `--registry-cache=false` for a local-only workflow. Registry locations require an untagged repository because Bunko creates per-key tags.

The CLI accepts `type=registry,repo=...`, `type=local,src=...` for reads and `type=local,dest=...` for writes. Unknown types, duplicate or unknown fields, empty fields and contradictory cache-disable settings are rejected. Paths are resolved against the current working directory. Commas are separators and cannot be included in location paths. GHA and S3 backends are not implemented. These options resemble Buildx syntax but the stored metadata is Bunko's format, not interchangeable with BuildKit exports.

Explicit local caches use the managed `keys/` and `blobs/` format, so `cache-info` and `prune --cache-dir` can manage them. Exports contain verified layer records; closure plan indexes remain in the default managed cache and in registry caches. Missing read directories are not created, and malformed or incomplete imports fall through to the next source. Writes use the cache lock and atomic metadata replacement. Cache paths are canonicalized and excluded from source snapshots; filesystem roots and overlaps with project roots or other output/input locations are rejected.

All targets are prepared before explicit exports. Each target’s exports follow its requested image publication. Dry runs and offline builds skip explicit exports; strict export mode rejects both. Offline builds may import local caches. Every requested destination is attempted even if another fails; strict mode fails after collecting export outcomes. Default local persistence failures do not disable explicit local or registry exports. `--local-cache=false` rejects explicit local locations and disables managed local persistence; `--cache-write=false` suppresses configured explicit exports without removing their read sources. An explicit local location may equal the managed cache directory, but nested cache roots are rejected.

Existing registry records are downloaded and verified before reuse during export, including their layer bytes. This can add network and decompression work when the build initially hit only the local cache. An invalid immutable cache tag requires operator recovery: select a new cache repository or remove the invalid tag if the provider policy permits it. Bunko does not change immutability or retention settings.

The internal `CacheBackend` contract provides validated record reads and per-record export outcomes for both transports. Key construction, digest/DiffID verification and compatibility checks remain shared; adding storage does not weaken cache identity or authenticate a cache producer.


`--local-cache=false` rejects explicitly configured local locations, and `--registry-cache=false` rejects registry locations in `--cache-from`/`--cache-to` and suppresses `--cache-repo` / `BUNKO_CACHE_REPO`. `--cache=false` rejects either type of `--cache-from`/`--cache-to` location and suppresses the configured cache repository. These differ from `--cache-write=false`, which suppresses valid configured exports and retains reads. Strict export mode requires an active write destination and rejects `--cache-write=false`. Equality with the managed local directory is the supported exception to cache overlap rejection; nested cache roots remain invalid. Existing or dangling symlinked explicit roots are rejected before use.

Strict `--cache-export-error=fail` requires an explicit `--cache-to`, `--cache-repo` or `BUNKO_CACHE_REPO` destination, including during a plain push. Existing strict jobs that relied on implicit image-repository writes must add a destination.
