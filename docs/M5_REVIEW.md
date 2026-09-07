# M5 review and validation

Claude Code 2.1.263 reviewed the cache, concurrency, syntax, build and toolchain changes with read-only tools. Findings were evaluated against the actual contracts.

Fixed findings:

- In-process writers now queue before acquiring the cross-process lock; lock warnings mention active contention. Blob copying stays inside the lock to prevent prune deleting the copied blob before the key is committed.
- Registry cache hits materialize and verify compressed bytes and DiffID during preparation. Corrupt or missing layers become misses before publication. Cached layers and decompression are bounded at 2 GiB.
- Disabled application caches emit an explicit bypass report event.
- Partial preparation reports preserve project order even when jobs finish out of order.
- The lock comment now describes writers/prune; unlocked readers tolerate deletion as misses.

Intentional contracts retained: prune age is record creation/update time, not last access; abandoned temporary/orphan files are not automatically deleted because active writers are not universally discoverable. These limits are documented in OPERATIONS.md. Remote tag updates are not claimed to be transactional across processes.

Validation includes content-change/macro failure memoization, bounded worker ordering/draining, warm application runtime/digest equality, corrupt local and missing remote cache recovery, parallel workspace digest equality and prepublication failure, and actual independent-process conflicting cache writers. Bun 1.3.11 passed the full suite; Bun 1.3.12 also passed the pre-review 199-test suite. Distribution/runtime checks exercise both Linux architectures and remote application hits. See PERFORMANCE.md for measurement limits.

CI showed intermittent subprocess-based fixture timeouts at Bun’s default five seconds (independent push runs passed). The suite budget is now fifteen seconds per test, with the same assertions and explicit shorter timeout tests retained. This accommodates compilation, executable hashing and independent-process fixtures under shared runner load.
