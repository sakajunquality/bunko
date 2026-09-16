# Keyless signing

Use a CLI release containing `--sign keyless` and stable cosign 3.x (validated with 3.1.3). Building still uses Bun; cosign handles OIDC, certificates, trust roots and transparency verification.

```sh
bunko build . --repo ghcr.io/example --sbom --provenance --sign keyless
bunko verify ghcr.io/example/app@sha256:DIGEST \
  --certificate-identity 'https://github.com/example/app/.github/workflows/build.yml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The default keyless service is Sigstore public good. Signing records image repository/digest and certificate identity in a public transparency log. Choose a private Sigstore deployment or existing key signing for identities and repositories that must remain private. `--sign-key FILE` remains shorthand for `--sign key --sign-key FILE`; its existing no-transparency-upload behavior is unchanged. Keyless and a private signing key are mutually exclusive.

## Identity and verification

On GitHub Actions, grant `id-token: write` and configure registry write credentials. Bunko forwards the request URL/token only for keyless signing. It also supports Buildkite's agent identity, Google with explicit `GOOGLE_APPLICATION_CREDENTIALS`, and explicit tokens via `SIGSTORE_ID_TOKEN`, `CI_JOB_JWT_V2`, or `--sign-identity-token @FILE`. A literal token is supported but shell history/process inspection can expose CLI arguments; prefer environment or a file. Bunko rejects unavailable identity before publishing instead of launching an interactive browser. Unconfigured GCE metadata identity is not automatically selected.

Explicit token files and profile files are excluded from application snapshots. Tokens are frozen into mode-0600 temporary files for cosign and removed after execution. Captured cosign output is bounded and never printed; failures contain fixed diagnostic categories. Reports/provenance contain signing mode, public/custom service, configured tlog policy and optional profile digest. They do not contain tokens, certificate values, or a claimed verified subject/issuer. These records describe intended signing configuration; inspect completion status and independently verify signatures.

Verification requires exactly one identity or identity-regexp constraint and exactly one issuer or issuer-regexp constraint. Prefer exact workflow identities; regexes should be anchored and narrowly scoped. Both `--verify-key`/`--key` and `--private-signatures` are exclusive to key verification. Signing and verification require immutable image digests.

A consumer can verify without bunko:

```sh
cosign verify --certificate-identity 'https://github.com/example/app/.github/workflows/build.yml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/example/app@sha256:DIGEST
```

This verifies the selected image signature. It does not recursively verify every platform or attachment, or create a DSSE-signed in-toto statement. Bunko signs the root, platform manifests and generated metadata artifact manifests by digest. Publication is not transactional: signing can fail after those manifests are published; use the failure report to identify incomplete work. Offline mode rejects signature services. The `ci` policy accepts key or keyless signing and still requires reproducibility, SBOM/provenance and prepared-dependency verification when configured.

## Custom Sigstore

`--sigstore-config FILE` accepts this wrapper, with paths relative to it:

```json
{
  "schemaVersion": 1,
  "signingConfig": "signing-config.json",
  "trustedRoot": "trusted-root.json",
  "oidcClientId": "sigstore"
}
```

Use cosign's native signing config (`application/vnd.dev.sigstore.signingconfig.v0.2+json`) and trusted root (`application/vnd.dev.sigstore.trustedroot+json;version=0.1`) obtained from the operator through a trusted channel. This avoids deprecated service flags and keeps Rekor/TSA selection in cosign. Bunko validates bounded regular JSON files and HTTPS endpoints without embedded credentials/query strings; cosign validates the actual trust material. Supply Fulcio and OIDC services plus Rekor by default. Native configs and roots are frozen before the build and identified together by a canonical digest in the report.

`--sign-tlog=false` requires a custom profile with TSA services and **no Rekor services**. Verification with that profile requires signed timestamps and explicitly ignores tlog verification; no profile with neither Rekor nor TSA is accepted. Public-good signing cannot disable tlog. A custom trust root is a trust decision: never accept one from the image being verified.

## Actions and validation

The build and rebase composite Actions accept `sign: keyless`, `sign-key` and `sigstore-config`. Install a compatible CLI and cosign first, and grant OIDC permissions in the caller. The rebase Action signs only after explicit container acceptance and before tag promotion.

[The manual staging workflow](../.github/workflows/keyless-staging.yml) requires a `sigstore-staging` environment with reviewed `SIGSTORE_SIGNING_CONFIG` and `SIGSTORE_TRUSTED_ROOT` JSON variables. Its guard rejects public-good endpoints; it never falls back to them. Configure environment reviewers and registry permissions before running it. It builds, signs and verifies using both bunko and cosign; ordinary PR CI uses isolated helper/registry fixtures. A configured workflow is not evidence that a live OIDC run has passed.

References: [Sigstore custom components](https://docs.sigstore.dev/cosign/system_config/custom_components/), [signing](https://docs.sigstore.dev/cosign/signing/overview/), [verification](https://docs.sigstore.dev/cosign/verifying/verify/).
