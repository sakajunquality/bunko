# Alpine and musl runtimes

musl support requires a release after v0.6.2 or a source checkout containing this feature. Earlier releases accept only `runtime.libc: "glibc"`. The default remains glibc.

```json
{
  "bunko": {
    "entrypoint": "index.ts",
    "runtime": { "libc": "musl" }
  }
}
```

With no explicit base, musl selects `oven/bun:<selected Bun version>-alpine`; glibc selects the version-matched distroless variant. Pin a suitable base by digest for reproducibility. An explicit base is still required when packaging native dependencies so that the application's library requirements are an intentional choice.

## Runtime and compiler selection

Supported verified runtime assets are Bun 1.3.13, 1.4.0, 1.4.1 and 1.4.2 for Linux amd64 and arm64. amd64 selects `bun-linux-x64-musl-baseline`; arm64 selects `bun-linux-aarch64-musl`. Every archive digest is pinned and checked against the official clear-signed checksum document with the embedded Bun release key. Custom compiler revisions and unavailable artifacts fail verification.

Bundle and source modes can use a compatible Bun already in the base or inject a verified release. Compile mode uses the authenticated musl executable through `--compile-executable-path`; the result must retain the matching architecture, interpreter and release revision. Compile mode keeps its existing restrictions on external dependencies and emitted assets. GnuPG's `gpgv` is required for compile and injection.

```json
{
  "bunko": {
    "base": "example.com/alpine-runtime@sha256:<digest>",
    "runtime": { "libc": "musl", "inject": "release" }
  }
}
```

The base must contain the architecture's executable musl loader and the runtime's required libraries. The verified releases require `libstdc++.so.6`; bare Alpine does not include it. Prepare a base with `apk add --no-cache libstdc++ ca-certificates` before using it with bunko. bunko does not run apk or install OS libraries. Missing loaders, wrong libc bases and missing injected/compiled musl runtime libraries are rejected before publication.

## Native dependencies and certificates

Native addons must have compatible Linux musl builds. Bun's cross-platform install may retain both GNU and musl optional variants; bunko preserves valid pairs and reports the opposite variant as inactive. An active addon requiring glibc `libc.so.6` fails an explicit musl build. Installing gcompat does not make arbitrary glibc native addons supported. Other native library/ABI requirements still require application testing; static file presence does not prove linker search or symbol compatibility.

Use `runtime.caCertificates` and, when needed for native clients, `runtime.systemCaTrust` as described in [certificate trust](RUNTIME_INJECTION.md). Injection does not import the host's CA store. An Alpine base's CA certificates do not automatically trust private issuers.

## Diagnostics and validation

```sh
bunko check-config . --deep
bunko check-base --base example.com/alpine-runtime@sha256:<digest> \
  --runtime-libc musl --runtime-inject release \
  --platform linux/amd64,linux/arm64 --run
```

`check-base` uses explicit flags, not package configuration. Without `--run`, it checks static evidence; `--run` executes the selected runtime in Docker and verifies its revision. A Bun-only check is not native-addon certification.

`bun run build && bun run test:musl` runs disposable Alpine image fixtures for bundle/source/compile, signed injection, native xxhash execution, private-CA HTTPS, cold/warm builds and incompatible-base rejection. Set `BUNKO_SMOKE_PLATFORMS` to select one architecture. CI tests each supported Bun release on native amd64 and arm64 runners. No private application source or production credentials are used.

Runtime download directories and layer/closure keys separate libc variants. Build reports record injected/compiled libc metadata, diagnostics show the selected libc, and images carry `org.bunko.runtime.libc`. Shared dependency layers reject targets with differing libc. Cache verification remains mandatory; changing libc never licenses reuse of incompatible native bytes.
