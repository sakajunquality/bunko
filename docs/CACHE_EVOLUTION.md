# Cache evolution proposal

This proposal tracks #220, #223 and #229. The current patch improves diagnostics and prevents pruning a closure plan solely because its packing fingerprint belongs to another CLI. It does not enable cross-version cache reuse or automatic crash recovery.

## Immediate behavior

New filesystem locks record hostname, PID and acquisition time. A confirmed dead local owner produces an actionable error without waiting for the full timeout. Unknown/foreign/legacy owners remain protected. Filesystem lock acquisition is capped at five minutes (existing shorter waits stay shorter); process-local queued work is still serialized behind its active operation. `cache-info`/local prune report `unreferencedBytes` and `temporaryBytes` separately from managed retention bytes. These are not automatically deleted: an apparently unreferenced file can belong to an active writer between blob completion and metadata commit.

For manual recovery, first stop every build/prune process sharing that cache, including other containers/hosts. Inspect the exact reported lock path and owner. Only after exclusive access is established, remove the stale lock and optional crash residue, or select a fresh cache directory. Never delete a lock merely because its mtime is old; a legitimate large transfer can outlive it.

## Required lease protocol

Automatic recovery needs an OS-backed lock, or a versioned atomic lease protocol honored by every writer and pruner. PID plus hostname/start time is useful evidence but does not prevent two reclaimers deleting a successor's lock. A new protocol must use a separate layout namespace so older mkdir-lock writers cannot participate unsafely. Acceptance must include SIGKILL between every publication step, PID reuse/foreign namespaces, two competing reclaimers, slow live writers, missing/malformed owner files, symlink attacks, and cross-filesystem copies.

Move content-addressed copies outside the metadata critical section only with a live-writer lease that prune respects. Publish records with bounded compare-and-rename under the metadata lock. Reclaim old temp/unreferenced blobs only after a reachability scan that conservatively retains references from unknown record versions and active leases. Account residue independently in dry-run output and revalidate candidates before deletion.

## Packing and semantic identity

Do not simply remove the Bun/bunko versions from today's `packFormat`. Separate a hand-versioned tar/compression format from per-layer semantic transformations and input identity. Assets can reuse validated content independently of CLI versions only when permission, omission, destination and packing policies agree. Runtime layers remain bound to authenticated archive/executable digests and runtime-layout policy. Dependencies retain installer/toolchain, lock, patch, script and platform policy. Application output retains compiler, defines, macros/input analysis, runtime kind and compile argv identity. Writer version is diagnostic metadata, not a substitute for these compatibility keys.

Introduce a new cache layout manifest carrying `layoutVersion` and minimum reader. Unknown namespaces/versions must be counted as unmanaged and preserved, not treated as corrupt current records or assumed to have no blob references. Malformed known records still fail validation. Default prune should age/budget foreign packing versions as ordinary candidates rather than eagerly deleting a rollback's warm path. Remote retention needs validated record creation metadata plus explicit age/keep filters and registry-specific tag-deletion support; do not infer age from arbitrary registry responses or delete manifests as a fallback.

## Delivery gates

1. Define and test the lease/layout boundary without enabling reuse across old/new layouts.
2. Introduce explicit per-layer packing/semantic versions and record writer identity.
3. Add unknown-version accounting, safe residue reclamation and remote retention filters.
4. Test cold/warm builds, concurrent writers/prune, immutable registry caches and upgrade/rollback using the previous two released CLIs against shared stores.
5. Enable documented cross-version reuse only for layer kinds proven equivalent by these tests.

The runtime-buffer optimization in #223 additionally needs invocation-owned verified files (or stable handles), not mutable shared-cache paths. Deduplicate downloads by authenticated version/platform/libc/policy, preserve file identity while packing/compiling, and bound transient extraction memory. Large-memory benchmarks, cancellation during extraction, tampering and cache eviction during reads are required before claiming the memory issue is solved.
