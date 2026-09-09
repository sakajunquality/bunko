# Supply-chain metadata and policy

Metadata is opt-in. `--sbom --provenance` publishes OCI subject artifacts alongside the runnable image and includes them in an OCI layout. They do not change the runnable image digest. The host Bun compressor version and the builder fingerprint do participate in image identity and application cache keys.

```sh
bunko build . --repo registry.example/team/app --sbom --provenance
bunko metadata registry.example/team/app@sha256:REPLACE_WITH_DIGEST --metadata-dir ./metadata
bunko metadata layout:./image --metadata-dir ./metadata
```

The metadata command checks manifest and payload digests and subject relationships before exporting. It supports the OCI referrers API and the referrers tag fallback. Output must be absent or an empty directory. `index.json` maps each exact payload file to its manifest and subject; exported bytes retain their original digest. Only SPDX 2.3 and in-toto Statement v1 with SLSA provenance v1 are exported. Unrelated artifact types are ignored. Unsupported envelopes, predicates, JSON documents and oversized individual metadata payloads are skipped and listed in `index.json` and the command result; digest and subject mismatches fail. This checks content integrity and binding, not the publisher's trustworthiness. Use `bunko verify` with a trusted key to verify signatures separately.

## Inventory scope

The SPDX document describes bundled and external runtime npm packages, recognized single SPDX license identifiers from package manifests, and the Bun runtime. Compound, missing, and unrecognized license declarations remain `NOASSERTION`. Declared licenses are not legal conclusions. Runtime inventory distinguishes an embedded compiled runtime from the expected base runtime; arbitrary custom base runtimes are not independently verified. Undeclared dynamic runtime loads are outside inventory coverage.

Base OS packages are not scanned by Bunko. Link a separately produced SPDX subject artifact explicitly:

```sh
bunko build . --repo registry.example/team/app --sbom --provenance \
  --base-sbom linux/amd64=registry.example/team/base@sha256:REPLACE_WITH_ARTIFACT_DIGEST
```

Repeat for each selected platform. The artifact subject must match the selected base platform manifest (an index subject alone is insufficient). Bunko checks artifact and payload digests and records an SPDX external document reference and provenance input. It does not merge, independently audit, or automatically trust the external inventory's package claims. The producer must publish it in Bunko's supported OCI subject artifact envelope (one SPDX payload and an OCI empty config).

## Builder identity

Provenance records source, lock, base, prepared dependency, base inventory, Bun executable and builder digests. A distributed JavaScript CLI records the SHA-256 of its actual bundle. Source execution records a fingerprint of Bunko's TypeScript sources, package manifest and lockfile; it is not a fingerprint of every installed third-party file or of the host OS. These are self-reported statements and do not establish a SLSA assurance level, hermetic execution, or an isolated build service.

## Prepared dependency trust and CI policy

```sh
bunko build . --repo registry.example/team/app --reproducible \
  --supply-chain-policy ci --sign-key producer.key \
  --deps-artifact linux/amd64=registry.example/team/deps@sha256:REPLACE_WITH_DIGEST \
  --deps-verify-key producer.pub
```

The opt-in `ci` profile requires reproducible mode and a signing key, enables SBOM and provenance, and requires a producer verification key when prepared dependencies are configured. Explicitly disabling either metadata type fails. It does not enable signature requirements for base images or enforce vulnerability policies.

`--deps-verify-key` is also available without the profile. Verification uses cosign v3.1.3 with the supplied key and immutable artifact reference before importing dependencies. Local dependency layouts cannot satisfy this policy. Unsigned or wrong-key artifacts fail before image publication. Private signatures are verified without requiring a public transparency log. Signing disables transparency-log upload. Custom registry TLS configuration cannot currently be passed through to cosign; the combined options fail explicitly. Configure trust and sign/verify separately when using that transport.

## Interoperability validation

`bun run test:metadata /absolute/new/output` uses a disposable Distribution registry and cosign keys. Set `BUNKO_COSIGN_PATH` to cosign v3.1.3. It checks unsigned and wrong-key rejection, accepted prepared dependencies, image/attachment signing, and metadata discovery. The fixture is synthetic and does not establish native runtime or OS scanner coverage.

The exported fixture was also checked with the [official SPDX 2.3 JSON schema](https://github.com/spdx/spdx-spec/blob/v2.3/schemas/spdx-schema.json) using jsonschema 4.26.0, and the [in-toto attestation Python bindings](https://github.com/in-toto/attestation/tree/main/python) 0.9.3 for Statement validation and SLSA v1 protobuf parsing. `scripts/validate-metadata.py` reproduces those independent consumer checks given the export directory and downloaded schema. These checks verify interoperability, not the factual correctness of package claims.

Integrated signing and dependency verification check `cosign version --json` before publication and require stable cosign 3 or newer. Version 3.1.3 is the tested release; accepting a newer version is not a claim that every future behavior is covered. Version checks have a ten-second deadline; each signing or verification command has a two-minute deadline. Signal termination and deadline expiry fail the operation. Helper output is captured with a 64 KiB limit per stream and never printed; errors expose only fixed classifications for TLS, authentication, keys, or signature verification.

Signing preserves uppercase and lowercase proxy variables, including `ALL_PROXY`/`all_proxy` and intentionally empty overrides, as well as the documented credential-helper settings. `COSIGN_REPOSITORY` and public-service overrides remain excluded so a caller cannot silently redirect integrated signatures to another destination.
