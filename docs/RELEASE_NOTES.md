# Unreleased

Retire Bun 1.4.0/1.4.1 and retain Bun 1.3.13 and 1.4.2 in CI and verified compile/injection pins. The host range becomes `>=1.3.13 <1.4 || >=1.4.2 <1.5`. Upgrade Bun to 1.4.2 or keep bunko v0.10.0 when an older 1.4 runtime is required. This change is not included in the immutable v0.10.0 artifacts.

## Format changes

Oversized SBOM build evidence may use v2 with explicit omission counts. Released 0.9.0/0.10.0 readers reject it during `rebase --sbom`; use a CLI containing #208. Node rebase capsules require readers from 0.9.0 onward. Build/rebase Actions now preflight bunko >=0.10.0 and <1 and validate report schemas. See [format compatibility](FORMAT_COMPATIBILITY.md) for rollback and remaining migration work.

# v0.10.0

This release adds opt-in native AWS registry authentication with `--auth-source aws`. Private ECR supports environment credentials, Web Identity token files (the STS path used by IRSA), ECS/EKS container credentials and IMDSv2. ECR Public authorization is also implemented. Docker-compatible authentication remains the default; profiles and SSO continue to use a credential helper.

Private ECR publication now accepts its HTTP 201 PATCH responses while retaining final digest completion and blob verification. The change fixes a real upload failure found during acceptance.

GitHub OIDC acceptance passed both native Web Identity → STS → ECR and temporary environment credential paths with a dedicated repository-scoped role. Checks covered credential refresh, chunked uploads, digest-verified pulls, blob reuse, CLI builds and private-base inspection. Local tests also verified immutable-tag conflict handling. Deployed EKS IRSA/Pod Identity, EC2 IMDSv2 and ECR Public remain protocol-tested rather than live-certified. See [AWS acceptance](https://github.com/sakajunquality/bunko/blob/main/docs/validation/aws-registry-credentials.md).

Bun >=1.3.13 <1.5 remains supported in this release. The independently versioned setup-bunko v0.1.1 Action still defaults to CLI v0.8.0; select `version: v0.10.0` explicitly after publication.

