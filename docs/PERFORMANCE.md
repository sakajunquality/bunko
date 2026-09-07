# Performance and cache correctness

`--jobs 1` is the default. Set `--jobs 2` (or `BUNKO_JOBS=2`) to prepare workspace targets concurrently. The limit is 32. Output order stays in target order. All started tasks finish before cleanup; no image is published until every target has prepared successfully. Publication stays sequential.

Application layers are cached by default. `--no-app-cache` disables only this cache; `--no-cache` disables every persistent layer cache. Keys include the complete source snapshot, normalized dependency inputs, executable bytes and revision, host/target platform, base digest, build settings, runtime dependency layers, aliases, packing format and timestamp. Workspace source changes conservatively invalidate every application key. A hit skips the build-only dependency installation and bundling; runtime dependencies and source validation still run. `--verify-deterministic` bypasses all layer caches and independently builds twice.

Successful syntax validation is memoized within one invocation, with a bounded 50,000-entry cache. Every lookup rereads and hashes the bytes, and the parser filename is part of the key. Failed validation is never memoized. This avoids repeated parsing across workspace targets and platforms, while a cold scan still inspects installed JavaScript/TypeScript. The `syntaxValidation` report counters are invocation-wide snapshots, not per-target costs to sum.

Local writers and prune cooperate through a directory lock. A valid, different layer under the same key causes a conflict instead of being overwritten. Readers verify copied blobs and tolerate missing/corrupt entries as misses. A stale lock is not automatically broken; inspect its owner before removing it. Remote cache publication checks existing records and refuses conflicting output. Registry tag updates do not provide universal compare-and-swap, so this is not a distributed transaction guarantee. Use a trusted cache repository: content addressing detects corruption, not a malicious writer replacing an entire valid record.

## Measurements

Run `bun run bench:performance` from an installed checkout. The benchmark prints its runtime, host, input count, timings, counters and resulting digests. It does not run as a unit test.

One macOS arm64 / Bun 1.3.11 run scanned 504 installed files. The first memoized pass took 1,553 ms and the second 125 ms, including rereading/hashing the same bytes. A small dependency fixture built in 338 ms cold and 179 ms with local caches, with identical image digests. These are illustrative measurements under concurrent test load, with filesystem warming and fixed execution order; they are not a general speedup claim. Raw output is in `validation/m5-performance.json`.
