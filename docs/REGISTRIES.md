# Registry configuration and verification status

M1 implements OCI Distribution push/pull and Docker-compatible credentials. Cloud SDKs are not bundled: use an authenticated Docker config or credential helper. bunko does not create repositories or change cloud IAM.

## Support matrix

| Registry | Example `--repo` prefix | Authentication | Verification status |
| --- | --- | --- | --- |
| GitHub Container Registry | `ghcr.io/OWNER` | Docker login, PAT, or workflow token | Automated helper and Basic-to-scoped-Bearer tests; real service push not verified. |
| Google Artifact Registry | `asia-northeast1-docker.pkg.dev/PROJECT/REPOSITORY` | gcloud/gcr helper or access token | Automated helper/Bearer tests; real service push not verified. |
| Docker Hub | `docker.io/USERNAME` | Docker login or credential store | Real public-base pull and automated host-alias/Bearer tests; account push not verified. |
| Amazon ECR private | `ACCOUNT.dkr.ecr.REGION.amazonaws.com/PREFIX` | ecr-login helper or AWS password | Automated helper/Basic-challenge/credential-refresh tests; real service push not verified. |
| OCI Distribution | `localhost:5000/demo` | Basic, Bearer, or anonymous | Real push/pull, cache reuse, and container execution with Distribution 3. |

bunko appends `bunko.imageName` or the project name to the prefix. For an exact repository, use `--bare`, for example `--repo docker.io/USERNAME/app --bare`. Create GAR projects/repositories and exact ECR image repositories beforehand. ECR Public, Harbor-specific extensions, referrers, and signing require separate validation.

Cloud publication tests require a user-selected repository and permissions. They were not run in M1/M2. Passing mock tests does not establish interoperability with a cloud service.

## Credential selection

Configuration path precedence:

1. `BUNKO_DOCKER_CONFIG`: a file path.
2. `$DOCKER_CONFIG/config.json`: Docker's directory-based convention.
3. `~/.docker/config.json`.

Credential precedence is host-specific `credHelpers`, then `credsStore`, then `auths`. A selected helper failure does not fall back to stale auths. Invoke `docker-credential-NAME get` from PATH and pass the server on stdin. Docker Hub's docker.io, registry-1.docker.io, and https://index.docker.io/v1/ aliases are normalized. [Docker credential stores](https://docs.docker.com/reference/cli/docker/login/#credential-stores)

Supported auths include username/password, base64 auth, identitytoken, and registrytoken. Follow HTTP 401 Basic/Bearer challenges, reusing Bearer tokens according to scope and expiry. Do not forward Registry Authorization across storage redirect origins. [Registry authentication](https://docs.docker.com/reference/api/registry/auth/)

## Examples

Replace uppercase placeholders with values for your environment. Log in once through Docker or use an existing credential helper.

### GHCR

A classic PAT needs write:packages and access to the destination. GitHub Actions can use GITHUB_TOKEN with packages:write and access to the repository/package. [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

```sh
# Interactive login keeps the token out of command arguments.
# In CI, pass the secret through docker login --password-stdin.
docker login ghcr.io --username USERNAME
bun run dev build examples/hello --repo ghcr.io/OWNER
```

### Google Artifact Registry

Configure the host helper in an authenticated gcloud environment. The standalone docker-credential-gcr helper and ADC are also supported. [Artifact Registry authentication](https://docs.cloud.google.com/artifact-registry/docs/docker/authentication)

```sh
gcloud auth configure-docker asia-northeast1-docker.pkg.dev
bun run dev build examples/hello \
  --repo asia-northeast1-docker.pkg.dev/PROJECT/REPOSITORY
```

### Docker Hub

```sh
docker login --username USERNAME
bun run dev build examples/hello --repo docker.io/USERNAME
```

### Amazon ECR

Install docker-credential-ecr-login and select it per host in Docker configuration:

```json
{
  "credHelpers": {
    "ACCOUNT.dkr.ecr.REGION.amazonaws.com": "ecr-login"
  }
}
```

The helper resolves AWS credentials. Alternatively, obtain a password with AWS CLI and pass it on stdin. ECR authorization tokens are valid for 12 hours. [ECR private authentication](https://docs.aws.amazon.com/AmazonECR/latest/userguide/registry_auth.html)

```sh
aws ecr get-login-password --region REGION | \
  docker login --username AWS --password-stdin ACCOUNT.dkr.ecr.REGION.amazonaws.com
bun run dev build examples/hello \
  --repo ACCOUNT.dkr.ecr.REGION.amazonaws.com/hello --bare
```

### HTTP development Registry

HTTPS is the default. Explicitly permit HTTP hosts, including loopback:

```sh
bun run dev build examples/hello --repo localhost:5000/demo \
  --insecure-registry localhost:5000
```

This option does not disable TLS certificate verification.

## Cache and publication failures

Cache tags default to `bunko-cache-v1-deps-<full-key>` and `bunko-cache-v1-assets-<full-key>` in the image repository. Use `--cache-repo` or `BUNKO_CACHE_REPO` for a separate cache repository. Unsupported custom OCI artifacts or denied cache writes produce diagnostics while image publication may still succeed. Disable Registry caching with `--no-registry-cache`.

Blob placement uses HEAD, then an available same-Registry cross-repository mount, then upload. Uploads use 8 MiB chunks and offset reconciliation. Publish platform manifests and the index by digest before updating tags. Multiple tags are not transactional: `--report` records published digests/tags and pendingTags on failure, with exit 1 and empty stdout. Existing tags are not rolled back.

Registry credentials and npm credentials are separate. Private npm uses HTTPS registry/scoped-registry configuration and `${ENV_NAME}` credentials from project .npmrc. Authentication files exist only in install staging and are removed afterward; values do not enter cache keys, images, or reports.
