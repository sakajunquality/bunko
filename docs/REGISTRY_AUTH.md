# Registry authentication

Bunko uses Docker-compatible credentials for destination images, private upstream images, image assets, and registry caches. It does not need a Docker daemon. `docker login` is one way to configure credentials; credential helpers are another.

## Selection and refresh

The configuration file is selected in this order:

1. `BUNKO_DOCKER_CONFIG`: a path to a JSON **file**.
2. `DOCKER_CONFIG/config.json`: `DOCKER_CONFIG` names a **directory**.
3. `~/.docker/config.json` for the user running Bunko.

Inside that file, a matching `credHelpers` entry takes precedence over `credsStore`, which takes precedence over `auths`. A selected helper is authoritative: Bunko does not fall through to an old inline password when it fails or returns no credentials. Helper executables must be on the Bunko process's `PATH`. Containers and CI runners need their own configuration and helper installation; a host login alone does not configure a container.

Bunko caches credential lookups during an invocation and asks the provider again during authentication refresh. Helpers can obtain fresh credentials; an expired token stored in `auths` needs a new login. Bunko does not automatically discover ambient AWS, Google, Azure, or GitHub credentials without a configured helper or login. Keep the current provider precedence when migrating from ko's built-in keychains.

## GitHub Container Registry

Configure `docker login ghcr.io` using a token through `--password-stdin`. For local private-package reads, use a token supported by GHCR with package read permission; pushing also needs write permission. In Actions, a repository's `GITHUB_TOKEN` needs appropriate `packages` permissions and access to the upstream package. Successful destination authentication does not imply access to a private base in another repository. See [GitHub's authentication instructions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Google Artifact Registry

After authenticating the intended Google account, configure the exact registry hostname:

```sh
gcloud auth configure-docker asia-northeast1-docker.pkg.dev
```

Keep `gcloud` and `docker-credential-gcloud` available to the user running Bunko. Select an identity with reader access for upstream images and writer access for output/cache repositories. If using a custom Docker configuration, ensure the generated `credHelpers` entry is in the file Bunko actually reads. Google also supplies a standalone helper. See [Google's Docker authentication guide](https://cloud.google.com/artifact-registry/docs/docker/authentication).

## Amazon ECR

Install `docker-credential-ecr-login` and merge an entry for the actual host into the selected Docker configuration:

```json
{
  "credHelpers": {
    "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com": "ecr-login"
  }
}
```

The helper obtains credentials through its supported AWS credential chain. Alternatively, refresh a login with:

```sh
aws ecr get-login-password --region ap-northeast-1 |
  docker login --username AWS --password-stdin \
    123456789012.dkr.ecr.ap-northeast-1.amazonaws.com
```

Replace the example account and region. Existing helper entries take precedence over the inline login. See [ECR authentication](https://docs.aws.amazon.com/AmazonECR/latest/userguide/registry_auth.html) and the [official helper](https://github.com/awslabs/amazon-ecr-credential-helper).

## Docker Hub

Use `docker login` with an authorized account or access token. Bunko normalizes Docker Hub's common configuration aliases and uses the Docker Hub server identifier for credential-helper requests. Private upstream reads and destination writes need their respective repository permissions. See [Docker login](https://docs.docker.com/reference/cli/docker/login/).

## Verify the actual workflow

A private base can be checked without publishing an output image:

```sh
bunko check-base --base ghcr.io/example/private-base:version
```

Then verify the application's full build with a new output directory:

```sh
bunko build ./app --base ghcr.io/example/private-base:version \
  --push=false --oci-layout ./image-check
```

Finally, publish only when intended, using the configured output repository. `check-config` and `doctor` are offline configuration/toolchain checks; they do not prove registry authorization. A separate cache repository also requires access, even when the image repository is writable.

## Troubleshooting

| Symptom | Check |
|---|---|
| Helper not found | Install the selected `docker-credential-*` executable on the Bunko process's PATH. |
| Helper failed | Check the cloud login/session and helper installation. Bunko deliberately does not print helper stdout/stderr. |
| 401 after refresh | Verify the selected configuration file, exact host, active account, and token expiry. |
| 403 / DENIED | Check repository scope, upstream package access, organization policy, and IAM. A fresh login cannot grant missing permissions. |
| Immutable-tag refusal | Choose the documented tag-conflict policy or another tag; this is not necessarily an authentication error. |
| Works locally, fails in CI/container | Verify that environment's configuration path, helper binary, identity, and repository access. |

Do not paste configuration contents, tokens, or raw credential-helper responses into bug reports. Report the operation, status, provider, and helper name with private identifiers removed. Bunko's authentication advice uses static provider guidance and does not include upstream error-body text.
