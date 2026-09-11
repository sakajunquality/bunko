# Compatibility and diagnostics

The accepted bundling toolchain range is Bun >=1.3.13 <1.5. The CI matrix pins Bun 1.3.13, 1.4.0, and 1.4.2 on Linux and macOS; this is the tested subset, not evidence for every accepted patch. Bunko 0.2.0 raises the minimum to 1.3.13. Bunko 0.1.4 remains available for 1.3.11/1.3.12.

Linux images support amd64 and arm64. glibc remains the default; select `runtime.libc: "musl"` for Alpine/musl. musl support requires a release after v0.6.2 or a source checkout containing the feature; v0.6.2 and earlier reject it. See [musl compatibility](MUSL.md). Bundle mode requires the selected Bun runtime in the image, either already in the base or added with opt-in [signed runtime injection](RUNTIME_INJECTION.md). Compile mode emits a Linux executable and still requires a compatible runtime base/system libraries. Use the default version-matched base or verify a custom one:

```sh
bunko doctor ./examples/hello
bunko check-config ./examples/workspace --target @example/api
bunko check-base --base oven/bun:1.3.13-distroless --platform linux/amd64,linux/arm64 --run
```

`check-config` is offline and validates selected manifests, workspace membership, supported settings and the text lockfile/dependency contract. Use repeatable `--asset-context NAME=DIR` bindings for declared mappings; selected external entries are checked without staging or hashing contents. It reports named entrypoints, default entries, logical asset mappings, modes, platforms, external packages and environment/define **names**, without their values or npm authentication configuration. Missing npm authentication variables do not block diagnostics; variables used in registry URLs must resolve. `doctor` also runs the selected Bun's `--revision` and checks whether optional docker, kubectl and cosign executables exist on PATH. Presence does not prove those tools, a daemon, credentials or a cluster work. Neither command installs dependencies, builds sources, contacts a registry or executes an image. Both list the checks they did not perform.

In a terminal both commands print an aligned text summary: a header line, a labelled block per selected target (entry, mode, platforms, base, dependency strategy, assets and mappings, environment and define names, user/workdir/ports, toolchain declarations, inherited defaults and warnings), the unchecked list, and for `doctor` the declared/selected toolchain comparison. When stdout is not a terminal — a pipe or a redirect — they print the same report as one JSON line, so existing scripts are unaffected. Only stdout decides: a terminal stderr, a CI environment variable or a job log changes nothing, and a caller that allocates a pseudo-terminal for stdout receives the summary, so pass `--format json` wherever the output is parsed. `--format json` and `--format text` select a format explicitly; anything else is rejected. Invalid configuration exits nonzero with an empty stdout and one `bunko: MESSAGE` stderr line in both formats, except that `--progress json` — which these commands reject as an unsupported option — reports even that rejection as a JSON error line.

A complete offline image check still requires a prepared base layout and dependency download cache:

```sh
bunko build ./examples/hello --push=false --base-layout ./base-layout \
  --oci-layout ./image-layout --verify-deterministic
```

## Installation and distribution

The supported CLI distribution is the self-contained `bunko.js` release artifact plus Bun. The setup action verifies the archive/checksum and selects this distribution; see RELEASING.md. Source checkout (`bun install --frozen-lockfile --ignore-scripts`, then `bun run build`) remains useful for development. No npm package is required. Private forks need appropriate release repository credentials; see [installation](RELEASING.md).

Application `--mode compile` is separate from distributing the CLI as a native executable. A standalone CLI binary, Windows support and automatic Bun upgrades are not provided. Explicit pinned Bun installations keep builds and cache keys traceable. A Bun patch change can change compiled output and cache keys; rebuild and recheck both image platforms before updating production.

## Migration from 0.1.0

Inherited root base users (including zero-padded UID 0) now default to `65532:65532`. This changes image digests and can affect permissions or low-port binding. Applications requiring root must explicitly set `bunko.user` or `--image-user` to `0:0`; explicit user settings remain authoritative. Validate runtime file access and startup with the selected base.

## Migration from earlier previews

Moving an existing Dockerfile build to Bunko is covered in [migrating from a Dockerfile](MIGRATING_FROM_DOCKERFILE.md). Changes between Bunko previews:

- `|` YAML block scalars preserve a trailing newline and are rejected as invalid bunko references. Use `|-` for an exact URI value.
- Boolean options accept `--flag`, `--no-flag`, and explicit `--flag=true|false`. A known flag supplied to an unrelated command is now an error, including `push-layout --push=false`; use `build --push=false --oci-layout DIR` for an export.
- Application cache entries are enabled by default and appear in reports/prune previews. Match cache events by `kind`, not positional index. Use `--no-app-cache` to bypass them.
- Remote cache hits verify compressed bytes and DiffID during preparation. This can download layers that earlier previews mounted without downloading; unchanged layers still avoid upload.
- `--jobs` changes preparation concurrency, not publication ordering or the all-target preparation gate. Start with 2 and measure your workspace.
- SBOM/provenance/signing remain explicit opt-ins. Private signing avoids transparency logs. External dependency artifacts require an exact platform/lock contract. See SUPPLY_CHAIN.md and OPERATIONS.md.

## Examples

`examples/hello` is a minimal HTTP server, `examples/dependencies` exercises JavaScript and native runtime dependencies, and `examples/workspace` demonstrates multiple services with workspace dependencies. `examples/sqlite` demonstrates writable runtime state under `/tmp`, health checks and an application that can be bundled or compiled. Runtime data is not an image asset; attach persistent storage if it must survive container replacement.

## Verified compile runtime

rc.3 and later require GnuPG's `gpgv` for compile mode as well as runtime injection. Compilation embeds the signature-verified, pinned official Linux Bun runtime through `--compile-executable-path`; it does not delegate runtime downloads to Bun. The output is checked for the target Linux ELF architecture and authenticated release revision marker; runtime smoke tests also execute it and compare the full revision. Bun 1.3.12 and later rewrite ELF sections, so the compiled output is not a byte-identical copy of the runtime input. The selected compiler remains part of the build trust boundary. Supported compile releases are 1.3.13 and 1.4.0–1.4.2, using x64-baseline or aarch64 assets for the selected glibc/musl runtime. Custom or unpinned compiler revisions fail verification. The host Bun executable remains selected by `--bun-path` and its digest remains an input to application caching.

`--runtime-cache` and `--no-cache` apply to these authenticated runtime inputs. Every build verifies cached signature and archive bytes before application-cache lookup. Compile input metadata appears as `images[].compileRuntime` in reports, enters the application cache key, and contributes release archive and signed-checksum dependencies to provenance. SBOMs identify the embedded runtime using the archive checksum; the unmodified Bun executable checksum is not presented as the compiled application's file checksum. Runtime execution is only verified by a separate runtime test. Runtime notices and release source information are packaged under `.bunko-runtime` in the application directory.

The compile stage honors `build.minify`; external sourcemaps and bytecode remain unsupported. See [Bun's executable documentation](https://bun.com/docs/bundler/executables), but use the supported-version tests as the compatibility boundary: current upstream documentation may describe later Bun releases.

## Runtime cache defaults

In every mode, Bunko defaults `BUN_RUNTIME_TRANSPILER_CACHE_PATH` to `0` in generated image configuration when the base has no explicit setting. Base and application environment overrides remain supported. This follows [Bun's container guidance](https://bun.com/docs/runtime/environment-variables) and avoids unnecessary implicit transpiler-cache writes; it is not a claim that every unset-cache application fails on a read-only filesystem.

## Bun 1.4 and version migration

Bun 1.4 support is available in rc.4 and later; the immutable rc.3 CLI accepts only the previous range. Starting with 0.2.0, stable host versions `>=1.3.13 <1.5` are accepted, with the CI points listed above. Releases rc.4 through 0.1.4 also accepted Bun 1.3.11/1.3.12. Canaries, prereleases and Bun 1.5 are rejected. Official compile/injection archives are separately pinned for 1.3.13 and 1.4.0–1.4.2, and every archive still requires the embedded trusted GPG signature policy.

Bun 1.4 generates text lockfile version 2. Bunko accepts lock versions 1 and 2 with config version 1, preserving registry-only resolution and integrity requirements. Version 2 requires a selected Bun >=1.4.0; builds and `doctor` reject an older compiler before dependency installation or registry access. `check-config` reports the lock version without executing Bun. Existing version 1 locks remain supported and are not automatically rewritten by Bunko. To adopt version 2, regenerate with the selected Bun 1.4 binary in your project and commit the resulting lockfile.

Update exact `packageManager`/`bunko.toolchain.version` declarations and `engines.bun` constraints deliberately. An explicit base that already contains Bun is not upgraded when the host toolchain changes; choose and test a compatible base, or use signed runtime injection. Native-addon ABI requirements remain unchanged as a validation responsibility.
