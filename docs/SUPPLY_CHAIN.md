# Supply-chain metadata and compiled applications

M3 metadata is opt-in. Neither repository visibility nor package visibility is changed. SBOMs contain package names and versions; review those identifiers before attaching them to a public image.

## SBOM and provenance

```sh
bunko build . --repo ghcr.io/OWNER --sbom --provenance
bunko build . --push=false --oci-layout ./image --sbom --provenance
```

Each platform manifest receives an SPDX 2.3 package inventory. Bundled packages are discovered from Bun's actual metafile inputs, and runtime packages come from the installed dependency inventory. Unused development dependencies are excluded. Packages are deduplicated by name/version. Base OS packages, undeclared runtime-loaded packages, and individual source files are not inventoried; unknown licenses and download locations use NOASSERTION. This is an application package SBOM, not a complete OS inventory or vulnerability assessment.

The root image receives an in-toto statement with a SLSA provenance v1 predicate. It records source, normalized lock, base digests, platforms, mode, and the exact Bun revision. It does not include environment variables, build define values, npm credentials, absolute checkout paths, or wall-clock timestamps. This self-reported predicate does not establish a SLSA assurance level.

Artifacts have OCI subjects and do not change runnable image digests. OCI layouts include artifact descriptors in their outer index; runnable platform indexes remain unchanged. Registry publication uses the referrers API when available and otherwise updates the standard `sha256-<digest>` fallback index. Fallback updates are serialized within a build and checked after writing. Registries provide no universal cross-process compare-and-swap for tags; concurrent writers to a fallback index remain a limitation.

Artifact failure fails the command after possible image publication. Digest-only stdout is withheld, and `--report` records the image and attachment descriptors. Docker archives cannot carry OCI subject artifacts; use OCI layout or Registry output for attachments.

## Private key-based signing

Validated tool: cosign v3.1.3, supplied separately. Keys remain outside the project and are never copied into images or provenance. KMS key URIs supported by cosign can also be supplied.

```sh
bunko build . --repo ghcr.io/OWNER --sbom --provenance --sign-key /secure/cosign.key
bunko verify ghcr.io/OWNER/app@sha256:DIGEST --verify-key /secure/cosign.pub --private-signatures
```

Signing explicitly disables cosign's public signing configuration and transparency-log upload. The root, platform manifests, and metadata artifact manifests are each signed by immutable digest. This signs the OCI artifact; it does not create a DSSE-signed in-toto envelope. Verification of private signatures requires the explicit `--private-signatures` option, which skips the public transparency-log requirement. Without it, cosign's normal log verification applies. Use COSIGN_PASSWORD through the environment when the selected key requires it. `--cosign-path` selects an executable.

## Compile and base checks

```sh
bunko build . --mode compile --platform linux/amd64,linux/arm64 --repo ghcr.io/OWNER
bunko check-base --base oven/bun:1.3.11-distroless --platform linux/amd64,linux/arm64
bunko check-base --base oven/bun:1.3.11-distroless --platform linux/amd64,linux/arm64 --run
```

Compile mode bundles and validates inputs first, then creates a Linux executable with the selected Bun toolchain. amd64 uses the baseline CPU target. Runtime externals, native addons, bytecode, and external sourcemaps are not supported in compile mode. The base must still provide compatible system libraries. The default base remains the Bun distroless image; compile does not imply a static executable or scratch compatibility. `--verify-deterministic` compares independent compiled outputs.

Base checks validate OCI platform/config metadata without Docker. `--run` additionally requires Docker and verifies the exact Bun revision in a pinned base, with networking disabled, a read-only filesystem, a nonroot user, and dropped capabilities. It does not prove compatibility with every application or native shared library. `--runtime-path` selects the Bun executable inside the base.

Validation commands: `bun run test:m3-smoke` runs compiled images and checks bases; `BUNKO_COSIGN_PATH=/path/to/cosign bun test/m3-signing-smoke.ts` creates disposable local keys and a Distribution 3 registry, signs and verifies images and attachments, then removes test resources.

References: [OCI manifests](https://github.com/opencontainers/image-spec/blob/v1.1.1/manifest.md), [SLSA provenance](https://slsa.dev/spec/v1.1/provenance), [Bun executables](https://bun.sh/docs/bundler/executables), [cosign signing](https://docs.sigstore.dev/cosign/signing/signing_with_containers/).

## Metadata extraction and policy

See [Metadata and policy](METADATA.md) for exact-payload export, base SPDX linkage, prepared dependency signature verification, runtime/license coverage, and the opt-in CI profile. The builder artifact/source fingerprint now participates in image identity; using a different CLI bundle or source tree changes image digests even when the version string is identical. Reproducibility comparisons must hold that fingerprint constant.
