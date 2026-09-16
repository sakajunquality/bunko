# Node HTTP application

Bun bundles this JavaScript application; Node serves JSON and reads an explicit `bunkodata` asset root. A compatible unreleased CLI containing Node runtime support is required until this feature ships.

```sh
bunko build examples/node-http --repo registry.example/team --platform linux/amd64,linux/arm64
bunko build examples/node-http --mode source --runtime-libc musl --oci-layout ./node-image --push=false
```

For local acceptance, use `bun run build && bun run test:node` from the repository root. The `--self-test` application argument performs a loopback HTTP request, checks the asset and nonroot UID, then exits. Normal startup listens on port 3000. See [Node runtime support](../../docs/NODE_RUNTIME.md) for base paths, limits and metadata semantics.
