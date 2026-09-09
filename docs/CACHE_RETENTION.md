# Cache distribution and retention

Bunko caches use its own OCI artifact format. They are not BuildKit cache records. Native/generated dependency keys retain platform and base compatibility inputs; this change does not introduce rebase or relax those constraints.

```sh
bunko build . --repo registry.example/team/app \
  --cache-from registry.example/team/main-cache \
  --cache-from registry.example/team/shared-cache \
  --cache-repo registry.example/team/branch-cache
```

Reads try the local cache, each `--cache-from` in order, then `--cache-repo` (the output repository by default when pushing). A denied, missing or corrupt cache source falls through to the remaining sources and then rebuilding. Every accepted layer is checked against its compressed digest and uncompressed DiffID. Reports identify the successful registry source and whether a final miss involved unavailable or invalid data.

Registry cache writes use only `--cache-repo` or its normal default destination and occur after successful image publication. Hits from another read repository are eligible for promotion to that destination. `--cache-write=false` keeps registry reads and disables registry cache writes; local persistence remains controlled by `--local-cache=false`. `--cache=false` disables both caches and cannot be combined with explicit read sources.

```sh
bunko cache-info --cache-dir ./cache
bunko prune --cache-dir ./cache --keep-bytes 1073741824
bunko prune --cache-dir ./cache --keep-bytes 1073741824 --execute
```

The byte budget covers validated key metadata plus its unique referenced blobs. Unknown files, unreferenced CAS objects, temporary files, lock metadata and filesystem overhead are excluded and untouched. This is a managed-byte budget, not a bound on total directory disk usage.

Budget pruning chooses the oldest metadata modification time first with a deterministic key tie-break. It is not access-time LRU. Shared blobs are counted once and retained until every selected reference is removed. `--older-than` remains available for age-based retention and cannot be combined with `--keep-bytes`. Both modes preview by default. Only `--execute` deletes; validation and the cache lock precede deletion. There is no automatic build-time GC. Bun's package download cache (`--install-cache`, by default `${XDG_CACHE_HOME:-~/.cache}/bunko/install/v1`) and the verified runtime download cache are separate directories outside this budget; `cache-info` and `prune` do not manage them, so reclaim their space directly.

Remote pruning remains provider-dependent tag-only deletion. No generic remote byte-budget claim is made.

## Optimization scope

Repeated builder measurements and CI workflows justify reusable read sources and explicit local retention. Finer scheduling, automatic base rebasing, remote workers and distributed tracing remain deferred. The benchmark is exploratory workstation evidence, not a general ranking against BuildKit; see [Build comparison](BUILD_COMPARISON.md).

## Trust and operational limits

Every read cache and its writers must be trusted as much as the build inputs. A digest and DiffID prove content integrity and internal consistency; they do not prove that a producer built the layer from the claimed cache inputs. A malicious cache writer can supply application/dependency contents and inventory, and promotion preserves that content in the write destination. Producer signature verification for prepared dependencies does not authenticate application caches. Use isolated trusted cache repositories, or disable caches when that trust cannot be established. The CI policy does not elevate cache trust.

Accepted registry hits are persisted locally only after build/determinism checks succeed. Cache metadata has an 8 MiB limit for writes and reads; larger records are not cached. Existing oversized or malformed local records require manual investigation before pruning.

Usage and preview operations take the same exclusive lock as deletion to provide a consistent snapshot. They require a writable cache directory and can wait for a writer; a read-only cache mount can still supply build hits, but cannot provide locked usage/prune queries. Lock files are temporary and are not included in managed usage.

Bun's extracted package download cache is trusted build input. Reusing an entry does not independently reverify its package integrity. Keep it private to the intended trust domain and never restore a cache writable by untrusted pull requests into a trusted publishing build. Use `--no-local-cache` without an explicit `--install-cache` to retain per-build temporary staging.
