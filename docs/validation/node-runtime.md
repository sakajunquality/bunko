# Node runtime validation

Validation on 2026-09-16 used Bun 1.4.2, the minimum supported Bun 1.3.13 for targeted regressions, and Docker with Linux amd64/arm64 execution.

| Scenario | Result |
| --- | --- |
| Node 24, glibc/musl × bundle/source × amd64/arm64 | Eight real container cases passed HTTP, asset reads and UID 65532 with a read-only root and no external network. |
| Node 22, glibc/musl × bundle/source, arm64 | Four local real container cases passed. Both architectures are also covered by the Node 22/24 CI matrix. |
| npm-prebuilt example, Node 24, glibc, amd64/arm64 | Both passed health/dependency checks and static HTML reads with nonroot/read-only execution. |
| check-base runtime startup, Node 24, amd64/arm64 | Both reported and executed Node v24.21.0. This does not verify an arbitrary application's declared engine range. |
| Rebase with real Node 24, glibc, arm64 | Identical runtime/base content preserved application layers, regenerated the SBOM, and passed explicit Node HTTP/assets acceptance. |
| Minimum Bun 1.3.13 | Node, location diagnostics, rebase operations and keyless targeted tests passed. |

The final integrated local full suite passed 914 tests with two environment-dependent skips before the last review corrections. Subsequent focused tests cover unused Bun test files, bare Bun imports, runtime class heritage, SBOM/capsule mismatches and changed-base policy decisions. PR CI records the final revision's complete test results.

The synthetic ELF unit fixtures test rejection and metadata contracts; they are not runtime execution evidence. Node SBOM versions remain declared majors and are never promoted to verified versions based on these example runs. No broad npm/native-addon compatibility certification, Node injection, SEA or type-stripping support is implied.

Reproduce runtime cases with `bun run build && bun run test:node`, selecting `BUNKO_NODE_MAJOR` and `BUNKO_SMOKE_PLATFORMS` when needed. The glibc bundle cases also perform an accepted rebase with preserved-layer checks. Follow `examples/prebuilt/README.md` to stage the npm/pnpm output before selecting Node.
