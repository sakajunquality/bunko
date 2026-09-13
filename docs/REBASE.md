# Rebasing an image

`bunko rebase` replaces a verified base layer prefix while preserving every generated application, dependency, asset and injected runtime layer. It reads OCI images and metadata; it never reads application source, invokes the application builder, or installs dependencies. The output is a new image with its own digest, configuration, attestations and signatures.

This command requires images built with `org.bunko.rebase.metadata` version 1. Published v0.7.0 images predate that metadata and must be rebuilt first. The command and metadata format are introduced together after v0.7.0.

## Inputs and outputs

```sh
bunko rebase registry.example/team/app@sha256:IMAGE_DIGEST \
  --old-base registry.example/team/base@sha256:ORIGINAL_BASE_DIGEST \
  --base registry.example/team/base@sha256:REPLACEMENT_BASE_DIGEST \
  --dry-run --report rebase-plan.json

bunko rebase layout:./original-image \
  --old-base layout:./original-base --base-layout ./replacement-base \
  --oci-layout ./rebased-image --report rebase-result.json

bunko rebase registry.example/team/app@sha256:IMAGE_DIGEST \
  --old-base registry.example/team/base@sha256:ORIGINAL_BASE_DIGEST \
  --base registry.example/team/base@sha256:REPLACEMENT_BASE_DIGEST \
  --repo registry.example/team/app --tag patched \
  --sbom --provenance --sign-key ./signing.key
```

Replace the digest placeholders with full 64-character SHA-256 values. All registry inputs, including the old base, must be digest-pinned. Local inputs use `layout:DIR`; `--base-layout DIR` is an alternative for the replacement. Use the exact original base input, including its index or layout wrapper identity. Repackaging the same platform manifest under a different index does not satisfy that identity. The old base is required explicitly so local/offline operation does not depend on guessing a registry from labels.

By default all runnable source platforms are included. `--platform linux/amd64,linux/arm64` selects an explicit subset. Duplicate, missing, unsupported or ambiguous source platforms fail. The replacement must supply every selected platform. Outputs preserve whether the selected source root was a single manifest or an index. No platform is silently dropped because compatibility checks failed.

`--repo` is an exact destination repository, with publication enabled when supplied. Without a repository, use `--oci-layout` or `--dry-run`. No mutable tags are added implicitly; repeat `--tag` to request them. `--push=false` permits a local export while retaining a repository name. Existing immutable tag refusals fail by default; `--tag-conflict skip` reports refused tags without converting authentication failures into success. Registry authentication, mirrors, host-scoped TLS configuration and publication concurrency use the same options as normal builds.

Dry-run performs all compatibility and metadata preparation, may download and decode layers, and can query the destination for transfer estimates. It does not export, publish or sign. A requested JSON report is still written. Reports list source/output digests, platform base transitions, preserved layer digests, compatibility policy, new attestations, signing status and publication results. Output directories must be absent or empty; report paths cannot overlap local inputs, policy files, TLS inputs or the output layout.

## Compatibility boundaries

The default `identical-files` policy requires the old and replacement effective base filesystems to match, including payloads, links, modes, owners and extended attributes. Layer count, compression and packing can differ. This supports base repacking and compatible image configuration updates, but deliberately does not authorize arbitrary OS-library patches.

A digest-bound ABI contract permits reviewed filesystem changes:

```json
{
  "schemaVersion": 1,
  "transitions": [
    {
      "platform": "linux/amd64",
      "oldBase": "sha256:REPLACE_WITH_OLD_PLATFORM_MANIFEST_DIGEST",
      "newBase": "sha256:REPLACE_WITH_NEW_PLATFORM_MANIFEST_DIGEST",
      "libc": "glibc"
    }
  ]
}
```

```sh
bunko rebase layout:./original-image \
  --old-base layout:./original-base --base-layout ./replacement-base \
  --compatibility-policy ./reviewed-abi-policy.json \
  --oci-layout ./rebased-image
```

The contract names **platform manifest digests**, not index digests. Add one transition per selected platform. It must be a regular JSON file no larger than 64 KiB; unknown fields and duplicate transitions fail. The policy file is a trusted assertion by the operator or base publisher that this particular OS update preserves the required ABI. Bunko binds and records that assertion; it cannot prove arbitrary ABI compatibility from ELF metadata. Review the contract through the same trusted process used to choose base images. A label on an untrusted replacement image is not a contract, and there is no force flag. The policy digest is included in the report and requested provenance.

Both policies also enforce:

- Exact original base manifest/config/index identity, layer descriptors, DiffIDs, generated layer order and reconstruction of the original configuration from the ownership capsule.
- Linux architecture and variant compatibility, the selected executable libc loader, the Bun executable's ELF interpreter and embedded build revision, and an unchanged Bun executable including its filesystem metadata. Bun upgrades require a rebuild, including compiled and injected runtimes.
- A direct regular executable entrypoint. Wrapper scripts and symlinked Bun entrypoints require rebuilding.
- Generated entries that remain intact, without changed replacement-base overlaps or non-directory parents. Generated whiteouts and special device entries are rejected; generated links must resolve inside preserved layers.
- Unchanged effective user, volumes, stop signal, loader controls and trust environment. Ordinary inherited environment variables, labels and ports are recomputed from the replacement; explicit overrides remain explicit even when they originally equaled the inherited value.

An explicit ABI contract additionally requires the same identifiable distribution `ID` from `os-release`. It cannot authorize a glibc/musl transition or a different Bun binary. Native addons and other generated ELF binaries, apart from the preserved Bun runtime itself, are unsupported with an explicit ABI contract and require rebuilding. They are allowed with byte-identical base filesystems, subject to the other gates. Preserved compiled executables are checked as the Bun runtime and retain their embedded Bun version.

These static gates and the operator's contract do not replace application acceptance tests. Filesystem inspection is bounded and never follows image links against the host filesystem. Full decoding means rebase does not promise zero downloads or zero temporary disk use.

## Metadata, signatures and failures

Old artifacts and signatures remain attached to the original image; they are never relabeled as evidence for the new digest.

`--sbom` requires exactly one supported Bunko SPDX inventory for each original platform. Bunko recreates its application and runtime inventory under the new subject and a new document namespace. Unsupported or ambiguous inventories fail before publication. This preserves inventory claims from the original publisher; it is not a fresh package scan. Old external base-document references are removed. Supply replacement references with `--base-sbom linux/amd64=REPO@sha256:ARTIFACT_DIGEST` or a local artifact layout; each must describe the replacement platform manifest. Without those inputs, the new SBOM explicitly omits base OS inventory.

`--provenance` emits an in-toto/SLSA statement with build type `https://github.com/sakajunquality/bunko/rebase/v1`. It records the original image, old/new platform bases, preserved layers, policy, inventory inputs and current tool identity. It makes no claim that source was freshly built. The image config retains the original builder/source labels for its preserved application layers; the rebase attestation identifies the tool performing the transformation.

`--sign-key` requires publication and explicitly signs the new root, platform manifests and generated attestations through cosign. Integrated signing does not submit to a transparency log. Verify the new subjects separately with the trusted public key.

Every selected platform and requested inventory is checked before the first registry mutation or layout export. Publication then uses the ordinary OCI uploader and referrer handling; platform manifests precede the final index. Registries provide no cross-tag transaction. A later tag, attestation, signing or output failure can leave the immutable image root published; the failure report and error identify that partial publication. Do not treat the presence of an image tag alone as proof that signing completed.

## Validation

Run `bun run build && bun run test:rebase` with Docker, OpenSSL and gpgv. This executes glibc and musl images in bundle, source and compile modes on amd64 and arm64, preserves layer identities, removes source before rebasing, and tests nonroot/read-only execution and private CA trust. Set `BUNKO_SMOKE_PLATFORMS` to select a native runner's platform.

`BUNKO_COSIGN_PATH=/path/to/cosign bun run test:rebase-registry` uses a disposable local Distribution registry and key pair to publish the new artifacts and cryptographically verify every signed subject. Synthetic binary fixtures in that test validate registry/signature handling; executable runtime coverage comes from the separate runtime smoke test. Unit and integration tests cover metadata tampering, repeated rebasing, unsupported transitions, whiteouts, all-platform preflight, authenticated sources, immutable tag policies and failure reports.
