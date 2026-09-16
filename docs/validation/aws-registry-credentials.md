# Native AWS credential acceptance

Validated on 2026-09-17 using Bun 1.4.2 on macOS arm64 and a dedicated private ECR repository in `ap-northeast-1`. The repository uses immutable tags. Infrastructure and raw local reports are deliberately not committed.

## Live results

The AWS source used a temporary local AWS session supplied as explicit access key, secret key and session token inputs. AWS CLI exported the local session; it did not acquire the ECR password. Bunko generated the SigV4 request and called the real ECR authorization API.

Passed:

- Native `GetAuthorizationToken`, host-bound credential selection, cached lookup and explicit refresh.
- Publication of an OCI image config, synthetic data layer, manifest and unique tag.
- A 24 MiB incompressible input layer uploaded in three chunks. ECR advertised a 10 MiB minimum chunk length.
- Tag resolution and digest/size-verified download of the config and compressed layer.
- Same-content publication to the same immutable tag and reuse of existing blobs.
- Rejection of a different manifest at the occupied tag; the original tag still resolved to the original digest.

The synthetic image validates registry transport, not executable application behavior. Validation images remain subject to the repository lifecycle policy.

## Compatibility fix found by live acceptance

Private ECR returned HTTP 201 for accepted PATCH chunks, rather than the Distribution specification's HTTP 202. The previous publisher stopped before completing the blob. Bunko now accepts that response only for private ECR hostnames, retains the returned upload location and still completes the upload with a digest-addressed PUT and verifies the resulting blob. It does not interpret PATCH 201 as a completed blob or relax acceptance for unrelated registries.

Regression coverage in `test/registry-recovery.test.ts` verifies multiple ECR chunks, final digest completion and rejection of PATCH 201 from an unrelated registry. The standard protocol expects 202: [OCI Distribution Specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md#pushing-a-blob-in-chunks).

## GitHub OIDC acceptance

[Workflow run 35157819828](https://github.com/sakajunquality/bunko/actions/runs/35157819828) passed both identity jobs on 2026-09-17. The manual workflow ran from main and checked out reviewed implementation commit `193befbde7819e417d967a4f13ae1553cbfdad7e`. Subsequent changes in this PR only clarify documentation.

- `web-identity`: GitHub supplied an audience-bound OIDC token file; bunko itself called regional STS `AssumeRoleWithWebIdentity`, signed the ECR token request and refreshed both credentials. Explicit request counts verified the native STS path and cached lookups.
- `environment`: AWS CLI exchanged the GitHub token for a temporary session in the same dedicated role; bunko consumed the three environment credential values and performed its own ECR authorization. No Docker credential helper or `docker login` was used.

Both jobs passed 24 MiB synthetic-layer publication, digest/size-verified pull, blob reuse, a real CLI build of `examples/hello`, and private-base inspection through the CLI. They used the dedicated repository-scoped role rather than the local administrative session. No long-lived AWS credentials were stored in GitHub. The workflow verifies a fixed implementation SHA; future implementation changes require a reviewed pin update before acceptance is rerun.

## Remaining live acceptance

Deployed EKS IRSA, EKS Pod Identity, EC2 IMDSv2 and ECR Public are not certified by these results; their current coverage is mocked/protocol-level. The GitHub token-file test verifies the same STS exchange implementation used by IRSA, but does not prove EKS service-account projection or cluster IAM configuration.
