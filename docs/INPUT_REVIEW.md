# Input and performance review

Claude Code performed an initial read-only review and a focused follow-up. Findings led to post-bundle validation of tracked source inputs, inclusion of shared JSON configuration, explicit required-input checks, selected-asset traversal without scanning installed node_modules, and preservation of compiler/error diagnostics in JSON progress mode. Ignored unrelated configuration is not parsed. Conservative fallback and redundant hashing remain performance limitations, not claims of incremental compiler equivalence.

Regression coverage includes unrelated member reuse with changing audit identity, shared config and mode invalidation, ignored entrypoints/extended configs/partial asset matches, ignored malformed configs, bounded execution and cache corruption. Existing independent determinism iterations retain separate bundle generation. The complete suite passed at the checkpoint; subsequent local/TLS/compression additions also passed the expanded suite.

The [builder comparison](BUILD_COMPARISON.md) records actual repeated measurements and their limits. It includes a frozen CLI digest and does not infer whole-system resource use from client-only counters.
