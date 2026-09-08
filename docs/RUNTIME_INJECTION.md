# Injecting Bun into a custom base

This feature is included in v0.1.0-rc.2; the immutable rc.1 release does not include it. Injection is opt-in. Normal builds still use an existing Bun-containing base.

```json
{
  "bunko": {
    "base": "gcr.io/distroless/base-debian12:nonroot",
    "runtime": { "inject": "release", "libc": "glibc", "bunPath": "/usr/local/bin/bun" }
  }
}
```

Use a digest-pinned base for reproducible builds. An explicit base (configuration, CLI, BUNKO_DEFAULT_BASE, or local OCI layout) is required. Current source supports bundle/source modes, Linux amd64/arm64, and official Bun 1.3.11–1.3.13 and 1.4.0–1.4.2 toolchains. Bun 1.4 support is not included in the immutable rc.3 release. It uses x64-baseline for amd64 and aarch64 for arm64. Compile mode, musl, unsupported versions and custom revisions that cannot be matched to the release are rejected. Injection does not change the default base, install native-addon libraries, add Node.js/shell tools, or run package hooks.

## Trust and downloads

Install GnuPG so `gpgv` is available on PATH. Only injection requires it; `doctor` reports availability. No automatic installation or keyserver lookup occurs during a build.

Bunko verifies the clear-signed `SHASUMS256.txt.asc` against its embedded official public key, fingerprint `F3DCC08A8572C0749B3E18888EAB4D40A7B22B59`, in an isolated temporary keyring. The authenticated text selects the ZIP checksum, which must also match the embedded digest pin for that exact release version and CPU asset. A valid signature from another release cannot substitute an older ZIP. There is no unsigned fallback or user-key override. Key rotation requires a reviewed Bunko update. This verifies an artifact signed by the pinned key; it is not a transparency-log, freshness or revocation service.

Downloads use explicit versioned GitHub release URLs and constrained HTTPS redirects, without forwarded credentials. Transfers, decompression and entries are bounded. A maintained ZIP parser (`yauzl`) reads only the expected regular executable; duplicate names, links and other entries fail. SHA-256 verification precedes extraction. The Linux binary is never executed on the build host.

The authenticated executable must contain the selected release version and commit identity. Its ELF architecture, interpreter, shared-library names and declared GLIBC symbol-version names are inspected. These checks do not prove that the image can execute it. `expectedRevision` and the full `releaseRevision` remain separate from actual runtime verification.

Verified downloads are cached under `$XDG_CACHE_HOME/bunko/runtime/v1`, or `~/.cache/bunko/runtime/v1`; override with `--runtime-cache DIR`. This is separate from `--install-cache` and the layer cache. `--no-local-cache` also disables the build's persistent runtime download cache; combining it with an explicit `--runtime-cache` is rejected. Cache hits reverify signatures, release pins and archive bytes. Corrupt cache entries are reported before attempting a verified replacement. Atomic writes and a per-release/architecture lock prevent cooperating writers from publishing partial entries. A contending download can wait up to 35 minutes; crashed locks are not removed automatically. The normal cache-info/prune commands manage layer caches, not this separate download cache.

## Layer and base requirements

Layers are ordered base, injected runtime, dependencies, assets, application. The executable is root-owned and mode 0755. The layer also includes upstream licensing notices and a source/release pointer under `/usr/share/licenses/bunko-runtime/`. It does not install bunx or node aliases. Existing user/environment inheritance remains unchanged.

Base layer metadata is read without extracting paths onto the host. Whiteouts and image links are considered when checking the interpreter. Injection destinations reject symlink/non-directory parents and non-regular existing targets. Missing destination directories are created; existing regular files at injection destinations are replaced. Generated layer collisions are rejected, including reserved runtime dependency namespaces. The layer cache key includes authenticated content, notices, platform/CPU, destination, policy, epoch and packing format. A cache hit must match the layer reconstructed from authenticated release bytes.

A runnable glibc loader is required. `distroless/static` and musl bases cannot run these releases. A loader's presence is only a preliminary check: libraries, symbol versions, CPU features, file permissions and application addons still matter. Do not apply the latest Bun documentation's minimum glibc claim retroactively to older releases. For example, the inspected 1.3.11 release declares GLIBC_2.25 symbols.

`distroless/base-nossl` includes CA certificates; its difference from `base` is libssl and associated dependencies, not absence of trust roots. Custom CA and real TLS behavior still require application validation. A native package may additionally require libgcc_s/libstdc++, for which a compatible cc/custom base is appropriate.

## Verify the composed runtime

```sh
bunko check-base --base gcr.io/distroless/base-debian12:nonroot \
  --runtime-inject release --platform linux/amd64,linux/arm64 --run

bunko check-base --base-layout ./base-layout \
  --runtime-inject release --platform linux/arm64 --run
```

`check-base` takes explicit flags; it does not read the application's runtime settings. Repeat `--runtime-path` when using a custom `runtime.bunPath`, and select the same `--bun-path` toolchain as the build. Without `--run`, it verifies and composes the release but does not execute it. With `--run`, Docker executes the composed image as numeric uid/gid 65532:65532, network disabled and filesystem read-only, and compares `bun --revision` to the toolchain. Local base-layout execution is supported with injection. Temporary tagged images and containers are removed afterward.

Build reports include `images[].runtime` with artifact digests, provenance URL, signer/policy, expected/release revision, ELF requirements and `revisionVerified: false`. A build alone never marks runtime execution verified. `check-base --run` reports the actual runtime revision separately and marks the injected runtime verified only after successful execution. The SBOM records the release ZIP checksum on the generic Bun package and the extracted executable checksum on a separate file element. Provenance records both the archive and signed checksum-document digests, including the verification policy and signer. Base OS inventory remains separate.

A Bun-only pass is not native-addon or application certification. `bun run test:runtime-injection` exercises signed releases, a compatible base, local OCI input, static rejection, cache reuse and a native addon that fails without libgcc_s. `BUNKO_SMOKE_INJECT=1 bun run test:application-validation` uses a pinned cc base and exercises actual DB changes, native hashing, HTTP/files and graceful shutdown. Both default to amd64/arm64; set BUNKO_SMOKE_PLATFORMS for a supported subset. Run `bun run build` first to test the distributed CLI.

## Source references

- [Bun 1.3.12 release Dockerfile and signing key](https://github.com/oven-sh/bun/blob/bun-v1.3.12/dockerhub/distroless/Dockerfile)
- [Versioned Bun CPU requirements](https://github.com/oven-sh/bun/blob/bun-v1.3.12/docs/installation.mdx)
- [Distroless base contents](https://github.com/GoogleContainerTools/distroless/blob/main/base/README.md)

Runtime injection does not preserve source-module locations or repair module-relative asset reads. See [application compatibility](APPLICATION_COMPATIBILITY.md).
