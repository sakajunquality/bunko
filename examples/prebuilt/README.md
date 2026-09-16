# Package npm or pnpm build output with bunko

Build a TypeScript HTTP server with Node.js and npm or pnpm, then pass only the generated `dist/` directory to bunko. The application uses Node's HTTP/filesystem APIs and an npm dependency, and serves a static HTML file. By default the resulting image runs the generated JavaScript with **Bun**; see below to select Node.

```text
npm ci / pnpm install -> npm run build / pnpm run build -> dist/ -> bunko -> OCI image
```

bunko does not run `package.json` build scripts or consume npm/pnpm lockfiles. This example uses `mode: "source"` to package the output without invoking Bun's bundler. The build script uses [esbuild's bundling options](https://esbuild.github.io/api/#bundle) to include the JavaScript dependency, copies static files and its license, and writes a dependency-free runtime manifest. No `bun.lock` or host `node_modules` is needed in that output directory.

## Build with npm

Requirements: Node.js 22 or later, npm, and a supported Bun version for bunko. From this repository root:

```sh
cd examples/prebuilt
npm ci --ignore-scripts
npm run build
cd ../..
```

## Build with pnpm

Alternatively, use pnpm 10 with Node.js 22 or later. From this repository root:

```sh
cd examples/prebuilt
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
cd ../..
```

Both lockfiles describe this same example so either path can be tried; a real project would normally keep only its chosen package manager's lockfile. Install scripts are unnecessary for this fixture on esbuild's supported platforms.

## Package the output

Install this repository's development dependencies once with `bun install --frozen-lockfile --ignore-scripts` to run the CLI from source. After either build above, run these commands from the repository root:

```sh
bun run dev check-config examples/prebuilt/dist --deep
bun run dev build examples/prebuilt/dist \
  --push=false --oci-layout .bunko-output/prebuilt \
  --verify-deterministic
```

The OCI destination must be absent or empty. Packaging needs registry access to download the public Bun base but does not require Docker. If using an installed CLI, replace `bun run dev` with `bunko`.

The generated `dist/package.json` contains:

```json
{
  "name": "prebuilt",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "bunko": {
    "mode": "source",
    "entrypoint": "server.mjs",
    "assets": ["public"],
    "ports": [3000]
  }
}
```

Point bunko at `examples/prebuilt/dist`, not the source project. The runtime context contains only this manifest, `server.mjs`, `public/index.html`, and `LICENSE-is-number`. The source project keeps its npm/pnpm lockfile and build tools outside that context.

## Run the image

With Docker running, build and load an image for your machine. Use `linux/arm64` on Apple Silicon or `linux/amd64` on x86-64:

```sh
IMAGE=$(bun run dev build examples/prebuilt/dist --local --platform linux/arm64)
docker run --rm -p 127.0.0.1:3000:3000 "$IMAGE"
```

From another terminal:

```sh
curl --fail http://localhost:3000/
curl --fail http://localhost:3000/health
# {"ok":true,"numberCheck":true}
```

The health response exercises the bundled npm dependency; the home page checks that the static asset is present and resolves relative to the generated server file.

Validated on 2026-09-14 with Node.js 22.23.2, npm 10.9.8, pnpm 10.1.0, and Bun 1.4.2 on Linux arm64. Both package-manager paths passed deterministic image packaging, HTTP/static checks, and execution as a nonroot user with a read-only root filesystem. The four files under `/app` matched their respective build artifacts byte for byte, with no `node_modules` in the application context. The pnpm path also exported a complete OCI layout.

## Adapting an existing project

Keep the existing npm/pnpm build and stage its deployable output in a separate directory with a bunko runtime manifest. Source mode preserves filenames, relative imports, and adjacent assets. Include all runtime files your framework needs.

This example bundles all npm dependencies. If the output still imports external packages, a dependency-free manifest is insufficient: declare those runtime dependencies and provide a consistent text `bun.lock` for bunko's controlled install, or use the supported [prepared dependency workflow](../prepared-dependencies/README.md) with its required manifests and lockfile. bunko does not directly copy an npm/pnpm `node_modules` tree.

The commands above retain the default Bun runtime. Test native addons and framework output in the final image; the optional Node path below changes the runtime while keeping the Bun packaging toolchain. For browser-only output, include a server entrypoint that serves those files. See [source mode](../../docs/SOURCE_MODE.md) and [application compatibility](../../docs/APPLICATION_COMPATIBILITY.md).

## Run the prebuilt output with Node

After generating `dist/`, use `bunko build examples/prebuilt/dist --runtime-kind node --repo registry.example/team`. The default glibc base contains Node 24. The dependency-free output still requires no bun.lock. Use a CLI containing [Node runtime support](../../docs/NODE_RUNTIME.md); `--runtime-libc musl` selects the official Alpine base.
