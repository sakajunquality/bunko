# Cache evolution proposal

This proposal tracks #220, #223 and #229. The current patch improves diagnostics and prevents pruning a closure plan solely because its packing fingerprint belongs to another CLI. Compatible packing identities no longer include the CLI or host Bun version. Version-aware retention remains a follow-up. Leased staging and conservative residue reclamation are implemented. New-format lock recovery is implemented as described below.

## Immediate behavior

New filesystem locks record hostname, PID, acquisition time and the identity of a persistent SQLite mutex inode. An exclusive OS lock plus a matching identity and confirmed dead local owner permits recovery of the directory guard after process death. PID liveness alone never authorizes recovery. Unknown, incomplete, foreign-host and legacy owners remain protected; confirmed dead legacy owners receive an actionable error. Filesystem lock acquisition is capped at five minutes (existing shorter waits stay shorter); process-local queued work is still serialized behind its active operation. `cache-info`/local prune report `unreferencedBytes` and `temporaryBytes` separately from managed retention bytes. Local prune can reclaim old owned residue explicitly; live staged copies are protected by a separate lease and blob/metadata publication holds the shared lock. See [CACHE_RETENTION.md](CACHE_RETENTION.md#crash-residue-and-staged-writes) for accounting and age limits.

For manual recovery, first stop every build/prune process sharing that cache, including other containers/hosts. Inspect the exact reported lock path and owner. Only after exclusive access is established, remove the stale lock and optional crash residue, or select a fresh cache directory. Never delete a lock merely because its mtime is old; a legitimate large transfer can outlive it.

## Required lease protocol

Recovery uses an OS-backed SQLite exclusive lock, without committed data or journal/WAL sidecars. The permanent `.bunko-lock.sqlite` inode must never be replaced during use. New writers retain the original directory guard inside that mutex, so older mkdir-lock writers still serialize with them and their guards are never automatically removed. Reliable filesystem locking is required. A crash before owner metadata is written, PID reuse, or an owner on another host still requires manual inspection. Acceptance must include SIGKILL between every publication step, PID reuse/foreign namespaces, two competing reclaimers, slow live writers, missing/malformed owner files, symlink attacks, and cross-filesystem copies.

Content-addressed copies now use separately leased staging directories. Publication retains compare-and-rename under the metadata lock. Prune reclaims old owned temporary/unreferenced blobs after validating every known record; unknown record formats still stop the operation. Future skip-and-count support must disable orphan reclamation when unknown records may contain references. Residue is accounted separately and revalidated before deletion.

## Packing and semantic identity

The hand-versioned `tar-gzip-v4` packing identity is separate from per-layer semantic transformations and input identity. A fixed compressed-byte fixture runs in every supported Bun/OS CI job; changes require investigation and a packing revision before reuse. Assets can reuse validated content independently of CLI versions only when permission, omission, destination and packing policies agree. Runtime layers remain bound to authenticated archive/executable digests and runtime-layout policy. Dependencies retain installer/toolchain, lock, patch, script and platform policy. Application output retains compiler, defines, macros/input analysis, runtime kind and compile argv identity. Writer version is diagnostic metadata, not a substitute for these compatibility keys.

Introduce a new cache layout manifest carrying `layoutVersion` and minimum reader. Unknown namespaces/versions must be counted as unmanaged and preserved, not treated as corrupt current records or assumed to have no blob references. Malformed known records still fail validation. Default prune should age/budget foreign packing versions as ordinary candidates rather than eagerly deleting a rollback's warm path. Remote retention needs validated record creation metadata plus explicit age/keep filters and registry-specific tag-deletion support; do not infer age from arbitrary registry responses or delete manifests as a fallback.

## Delivery gates

1. Define and test the lease/layout boundary without enabling reuse across old/new layouts.
2. Introduce explicit per-layer packing/semantic versions and record writer identity.
3. Add unknown-version accounting, safe residue reclamation and remote retention filters.
4. Test cold/warm builds, concurrent writers/prune, immutable registry caches and upgrade/rollback using the previous two released CLIs against shared stores.
5. Enable documented cross-version reuse only for layer kinds proven equivalent by these tests.

The runtime-buffer optimization in #223 additionally needs invocation-owned verified files (or stable handles), not mutable shared-cache paths. Deduplicate downloads by authenticated version/platform/libc/policy, preserve file identity while packing/compiling, and bound transient extraction memory. Large-memory benchmarks, cancellation during extraction, tampering and cache eviction during reads are required before claiming the memory issue is solved.
