# Compile a Bun application into an image

Bunko's `compile` mode creates a Linux executable containing the application and Bun runtime, then puts it into an OCI image. Start with the runnable [compile example](../examples/compile). This is application compilation, separate from how the bunko CLI itself is distributed: the published CLI is bundled JavaScript and still requires Bun on the build host.

## Prerequisites and first build

Bunko v0.12.1 generally accepts host Bun `>=1.3.13 <1.4 || >=1.4.2 <1.5`. Compile mode additionally requires the selected compiler to match an authenticated runtime archive; those archives are currently pinned to official Bun 1.3.13 and 1.4.2. Use one of those exact releases and GnuPG's `gpgv` for compilation. Other accepted host patches require a reviewed runtime pin before compile mode can use them. Linux and macOS build hosts are supported. Network access is needed for uncached base images and authenticated runtime assets. Docker is unnecessary for image construction; running the resulting container locally requires a container runtime.

```sh
bunx @sakajunquality/bunko@0.12.1 build examples/compile \
  --platform linux/amd64 \
  --push=false \
  --oci-layout /tmp/bunko-compiled-image \
  --verify-deterministic
```

Run from the repository root and choose an absent or empty output directory. The example declares `"mode": "compile"` in its `package.json`. For another application, select it on the command line with `--mode compile`, or add the configuration alongside the existing package fields:

```json
{
  "bunko": {
    "mode": "compile",
    "assets": ["data"]
  }
}
```

The [example README](../examples/compile/README.md) includes Docker archive export, loading, execution, and expected output. `--verify-deterministic` builds independent outputs and compares them; reproducibility across invocations also requires stable inputs, including a digest-pinned base. See [the reproducibility contract](SPEC.md).

## What gets compiled

Bunko bundles and validates the application first. It currently requires one emitted JavaScript entrypoint, then compiles that output with the selected host Bun compiler and an authenticated official Linux runtime supplied through `--compile-executable-path`. It verifies runtime archive digests and signed release checksums, and checks the compiled output's architecture and release revision evidence. The build report includes `compileRuntime` metadata. The host compiler remains part of the build trust boundary.

The image entrypoint runs the executable directly. A separately installed Bun command is unnecessary for that entrypoint, although the default base is still the version-matched Bun distroless image. Compilation does not automatically select scratch or remove Bun from an existing base.

## Platforms and libc

Targets are Linux amd64 and arm64. The default is glibc; `--runtime-libc musl` selects musl and, without an explicit base, the matching Bun Alpine image. The base must provide the correct loader and compatible shared libraries. A single executable is not a guarantee of static linking or independence from the operating system.

For a registry build, authenticate first and replace the destination with your repository:

```sh
bunx @sakajunquality/bunko@0.12.1 build examples/compile \
  --platform linux/amd64,linux/arm64 \
  --repo ghcr.io/YOUR_USER/compiled-example --bare --tag demo
```

Each platform receives its own executable. Test each image on the intended architecture. See [Bun compatibility](COMPATIBILITY.md) for runtime verification and [Alpine/musl](MUSL.md) for base requirements. Bunko does not install OS packages into a base.

## Assets and Bun's single-file features

Declared `assets` and `assetMappings` can add runtime files to the image. In the example, `Bun.file("data/message.txt")` reads a real file relative to the image working directory. The file is packaged alongside the executable; it is not embedded by the `assets` setting. Generate frontend output or other data before invoking bunko. See [asset configuration](CONFIGURATION.md#asset-exclusions-and-permissions) for exclusions, permissions, contexts, image sources, and verified URL sources.

Bun's own compiler supports more input forms than bunko currently exposes. In particular, bunko compiles its validated single JavaScript output rather than passing an arbitrary source tree directly to Bun's compiler. Do not assume a successful direct `bun build --compile` command will work unchanged through bunko.

| Input or feature | Compile-mode behavior |
| --- | --- |
| Ordinary bundled JavaScript/TypeScript | Supported when bundling emits one JavaScript entrypoint. |
| Literal dynamic imports | Supported when Bun includes them in that single output. |
| Declared runtime data files | Supported as image files; configure their runtime paths explicitly. |
| Runtime externals and native `.node` addons | Unsupported; use an appropriate bundle/source configuration. |
| HTML routes or builds emitting extra JS/CSS/assets | Rejected before compilation; use bundle mode. |
| Computed application imports, macros | Unsupported. |
| Multiple named entrypoints | Unsupported; use bundle mode. |
| Bytecode and external sourcemaps | Unsupported. |
| Bun runtime argument configuration | Execution-only subset embedded with `--compile-exec-argv`; application `args` remain separate. |

See [application compatibility](APPLICATION_COMPATIBILITY.md) and the [build contract](SPEC.md) for detailed input rules. A declared data file and an extra file emitted by the bundler are different cases: the former is explicitly packaged; the latter currently prevents compilation.

## Validation

The checked-in [compile smoke test](../test/compile-smoke.ts), run with `bun run test:compile-smoke`, checks deterministic compiled images, literal dynamic imports, declared runtime assets, architecture, and authenticated runtime revision by executing containers. [musl validation](MUSL.md#diagnostics-and-validation) also exercises compiled Alpine images. These require the repository's development dependencies and Docker in addition to the compiler prerequisites.

Run the example's actual container as well when changing its code or runtime assets. A successful compile alone does not establish that every runtime path, shared library, or application behavior works in the final image.

## Runtime options

Compile mode accepts `runtime.args` execution options such as `--smol`, `--no-install`, TLS trust flags and profiling flags. Bunko embeds them with Bun's `--compile-exec-argv` on the supported 1.3.13/1.4.2 toolchains. They are not appended as application arguments and are not a total-memory limit. For example:

```json
{ "bunko": { "mode": "compile", "runtime": { "args": ["--smol", "--no-install"] } } }
```

The compile subset excludes source loading/resolution, watch/inspect and environment-file options requiring external inputs. Values containing whitespace, quotes or backslashes are rejected rather than ambiguously splitting the embedded argv string. Profiling output needs a writable mounted directory such as `/tmp`. See [Bun executable options](https://bun.com/docs/bundler/executables).

The normalized embedded arguments participate in the application cache key. Existing provenance reports the argument count/digest without exposing values; compiled bytes and preserved application-layer digests bind those settings during rebase. No new rebase capsule field is required, and rebase cannot alter embedded flags without rebuilding.
