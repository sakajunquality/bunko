# v0.10.0

This release adds opt-in native AWS registry authentication with `--auth-source aws`. Private ECR supports environment credentials, Web Identity token files (the STS path used by IRSA), ECS/EKS container credentials and IMDSv2. ECR Public authorization is also implemented. Docker-compatible authentication remains the default; profiles and SSO continue to use a credential helper.

Private ECR publication now accepts its HTTP 201 PATCH responses while retaining final digest completion and blob verification. The change fixes a real upload failure found during acceptance.

GitHub OIDC acceptance passed both native Web Identity → STS → ECR and temporary environment credential paths with a dedicated repository-scoped role. Checks covered credential refresh, chunked uploads, digest-verified pulls, blob reuse, CLI builds and private-base inspection. Local tests also verified immutable-tag conflict handling. Deployed EKS IRSA/Pod Identity, EC2 IMDSv2 and ECR Public remain protocol-tested rather than live-certified. See [AWS acceptance](https://github.com/sakajunquality/bunko/blob/main/docs/validation/aws-registry-credentials.md).

Bun >=1.3.13 <1.5 remains supported in this release. The independently versioned setup-bunko v0.1.1 Action still defaults to CLI v0.8.0; select `version: v0.10.0` explicitly after publication.
