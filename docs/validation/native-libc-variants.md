# Native libc variant advisory validation

A disposable source-mode project used `@napi-rs/canvas` 1.0.5 and `@resvg/resvg-js` 2.6.2 with Bun 1.4.2. Its workload rendered PNGs using both packages without fonts or network access. Frozen Linux production installs retained GNU and musl optional packages; no install scripts were enabled.

Both Linux architectures were built against `oven/bun:1.4.2-slim` and `oven/bun:1.4.2-distroless`. The selected immutable base manifests and observed results are recorded below. Generated images ran with the default nonroot user, a read-only filesystem, no network, all capabilities dropped and no-new-privileges.

| Base | Architecture | Selected base manifest | Inactive musl addons | Missing library advisories | Runtime result |
| --- | --- | --- | --- | --- | --- |
| slim | amd64 | `sha256:debbe76858f2e398d2937c1eceeb82c571ac1fcd78aadf00e9634578ac2b5ef7` | 2 | 0 | PNG rendering passed |
| slim | arm64 | `sha256:5c51cee225076d3c7db2150683141476298062489de4660f2d1729e522641f91` | 2 | 0 | PNG rendering passed |
| distroless | amd64 | `sha256:139827a1de8540962e7e1add6980a99ffaf1a7c9d31e26e3ba0c3d3cc07e7bf3` | 2 | 2 | Expected libgcc_s.so.1 load failure confirmed |
| distroless | arm64 | `sha256:de68841ad46565a7d6eae43c49bbfd20776bcf0fd9c937a1f18ba5ad6d909dde` | 2 | 2 | Expected libgcc_s.so.1 load failure confirmed |

The two real distroless findings per architecture are `libgcc_s.so.1`, required by each GNU addon. Slim produced no missing-base-library warnings. The amd64 resvg musl addon uses `libc.musl-x86_64.so.1`; the other tested musl addons use `libc.so`. Both dependency spellings are covered by architecture-aware tests.

Regression tests retain warnings for an incompatible addon without a corresponding alternative, mismatched versions or architectures, unrelated paths, conflicting ELF evidence and unknown, mixed or non-executable loaders. This static advisory classification does not remove files or prove arbitrary application loader behavior. Applications that explicitly load the opposite-libc file can still fail.
