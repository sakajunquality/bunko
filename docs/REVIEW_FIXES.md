# Correctness review follow-up

Validated on 2026-09-08 with Bun 1.3.11 (revision af24e281), macOS arm64. These corrections apply after the M2 implementation and supplement the earlier validation records.

| Finding | Correction and regression coverage |
| --- | --- |
| Macro detection matched comments and strings | Parse JS/TS/JSX/TSX syntax with the pinned TypeScript parser. Reject actual import attributes and macro specifiers without resolving imports or executing source. Cover comments, strings, regexes, template expressions, JSX, and installed TypeScript/Bun declarations. |
| Bun's default download cache entered the image | Always pass an explicit install-cache directory. The default is inside temporary build staging, outside node_modules. Compare default and explicit-cache production layer digests. Increment production dependency layout keys so old cached layers cannot retain the accidental cache. |
| A 120-second deadline interrupted transfers | Bound GET/HEAD header acquisition, then clear the timer. Do not apply this deadline to response bodies or upload requests. Keep caller cancellation and bounded read-header retries; upload recovery still reconciles committed offsets. |
| Explicit default Registry ports broke authentication | Normalize origins through URL parsing for authorization, challenge handling, and the HTTP allowlist. Keep the configured Registry name for credential lookup. Cover HTTPS :443, HTTP :80, and credential stripping across redirects. |
| Unbounded hashing exhausted descriptors | Hash at most 16 files concurrently, preserving record order. Drain active workers before returning a failure. Use the same limit for workspace-source fingerprints. Exercise 2,048 streams with a 256-descriptor process limit. |
| Bundled dependencies generated self-links | Keep real nested package directories when an edge already resolves to its alias path. Preserve dependency executable links. Extract the archive and run the nested dependency. |
| Unrelated ancestor workspaces captured standalone apps | Adopt an ancestor workspace only when its declaration matches the selected package. Ignore malformed or unreadable unrelated ancestor manifests. Explicitly selected projects and applicable workspace declarations remain strict. |
| Upload status required Location | Retain the last complete upload URL, including its signed query, when a status GET omits Location. Honor replacement URLs when supplied. Cover both committed chunks and ambiguous empty sessions. |
| Invalid bunko URIs passed through resolve | Reject whitespace, control characters, queries, and other invalid URI characters before discovery/build/publication. Preserve the documented template-expression behavior. Cover YAML block scalars and quoted YAML/JSON values. |
| Explicit boolean values were inconsistent | Normalize every declared boolean option, including negative forms, while preserving string arguments and values after `--`. Strict parsing still rejects invalid values and unknown flags. |
| Layer-collision checks scaled quadratically | Index exact paths, case-folded paths, and implicit parent directories. Cover both insertion orders, implicit case collisions, directory reuse, and 40,000 entries. |

The unmodified output of `bun init -y` also contains a symlink under `.cursor/rules`. Exclude `.cursor` editor metadata from snapshots; application source symlinks remain unsupported. An actual starter project now builds twice with matching image digests and an app-only layer.

## Transfer experiment

An actual Bun HTTP server held a response stream and an 8 MiB PATCH response open for 125 seconds. The previous client failed both requests at approximately 120 seconds. The corrected client received the complete GET body and PATCH 202 response at approximately 125 seconds. This experiment is separate from the short deadline regressions in the test suite.

The change removes an inappropriate total transfer deadline. It does not add resumable downloads or claim that arbitrary interrupted response streams are retried. Download consumers continue to verify size and digest. Authentication metadata retains its separate 30-second deadline.

## Compatibility and distribution

`--target .` continues to select the workspace root explicitly. The review's broader structural refactors are outside this change.

The TypeScript 5.9.3 parser is bundled into the CLI, increasing the unminified artifact to approximately 9.2 MB. It does not require an external npm installation at runtime. Its Apache 2.0 license is retained in the bundle and in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). This favors a maintained syntax parser over another partial JavaScript lexer.

The status-GET Location fallback tolerates Registry implementations that omit the header. The [OCI Distribution specification](https://github.com/opencontainers/distribution-spec/blob/v1.1.1/spec.md#chunked-upload) still requires Location in that response; this compatibility fallback is not a claim that omission conforms to the specification or that Quay has been tested live.
