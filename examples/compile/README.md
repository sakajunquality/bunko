# Compiled application with a runtime asset

This dependency-free application compiles into a Linux executable containing the Bun runtime. It reads `data/message.txt` from the image's working directory and prints JSON. The text file is a declared image asset, not embedded in the executable.

Run the commands below from the repository root. Install a supported official Bun release (for example 1.4.2) and GnuPG's `gpgv` first. Docker is only needed for the final container execution.

```sh
bunx @sakajunquality/bunko@0.12.4 build examples/compile \
  --platform linux/amd64 \
  --push=false \
  --tarball /tmp/bunko-compile-example.tar \
  --report /tmp/bunko-compile-example.json \
  --verify-deterministic

image=$(docker load --input /tmp/bunko-compile-example.tar | sed -n 's/^Loaded image: //p')
test -n "$image"
docker run --rm --platform linux/amd64 --network=none \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --user=65532:65532 "$image"
```

Use unused output paths. The build downloads a compatible public base and verifies the selected official Bun runtime. The default libc is glibc. On an arm64 host, use `linux/arm64` in both commands to avoid amd64 emulation.

Expected output includes `"message":"Hello from a compiled Bun application!"`, `"architecture":"x64"` (or `"arm64"`), and the selected Bun release's revision. No writable application directory or network connection is needed at runtime. The report records `mode: "compile"`, deterministic verification, and authenticated `compileRuntime` metadata.

See the [compile-mode guide](../../docs/COMPILE.md) for prerequisites, platforms, assets, publishing, and unsupported features. The executable still needs compatible system libraries; this example does not produce a static or scratch-compatible binary.

For memory-sensitive workloads, set `bunko.runtime.args` to `["--smol", "--no-install"]` to embed these Bun execution flags. Application arguments remain in `bunko.args`. See [compile runtime options](../../docs/COMPILE.md#runtime-options) for the supported subset and writable profiling directories.
