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

## Explicit credential sources

Use `--auth-source docker,github` (repeatable) or `BUNKO_AUTH_SOURCES=docker,github` to enable an ordered source chain. CLI selection replaces the environment list. The default remains Docker configuration only; setting `GITHUB_TOKEN` alone has no effect. Unknown or empty source names are errors. Identity configuration is not read from package.json.

The GitHub source answers only for `ghcr.io` (including explicit HTTPS port 443), using `GITHUB_TOKEN` before `GH_TOKEN`, with `GITHUB_ACTOR` or `x-access-token` as username. A nonstandard port or lookalike hostname receives no token. Supply the token explicitly in Actions:

```yaml
permissions:
  contents: read
  packages: write
steps:
  - run: bunko build . --repo ghcr.io/example/app --bare --auth-source github
    env:
      GITHUB_TOKEN: ${{ github.token }}
```

An absent source can fall through. A configured Docker helper or inline entry is authoritative. A failure stops the operation; a not-found result stops the source chain but still permits anonymous registry access. Neither case silently switches identities. The default Docker-only helper behavior is unchanged. Credentials are refreshed per invocation and concurrent refreshes share a lookup.

`bunko auth-check ghcr.io --auth-source github --scope repository:example/app:pull,push` probes `/v2/` and its challenge using the normal origin restrictions. Its JSON identifies the source and credential kind without exposing values. An unchallenged response is reported separately. Authentication success does **not** prove repository pull or push permissions; scopes are requested, not asserted as granted. `doctor` remains offline.

When non-Docker sources are enabled, signing and verification pass selected credentials to cosign through a mode-0600 temporary Docker configuration containing only the target registry. The file is removed on success or failure; an uncatchable termination such as SIGKILL can leave a private temporary directory requiring cleanup. Docker-only selection keeps cosign's existing helper behavior. The bridge does not change the user's Docker configuration. No credential values enter argv, reports or provenance. Registry authentication and keyless OIDC identity remain separate requirements. Offline builds do not resolve credentials.

### Google and workload identity

Enable `--auth-source google` for `gcr.io`, its regional hosts, or `LOCATION-docker.pkg.dev`. An explicitly provided `GOOGLE_OAUTH_ACCESS_TOKEN` is authoritative. Otherwise bunko queries the fixed Google metadata token endpoint, requiring the Google response header, validating expiry, and refreshing before expiration. Metadata calls bypass proxies, reject redirects, have a five-second deadline per attempt and retry a transient failure once (at most about 10.1 seconds per request, excluding scheduler overhead). Failed discovery does not fall through to another identity.

On GKE or Cloud Build, grant the workload identity access to the intended Artifact Registry repository. The metadata path uses that workload's service account; it does not implement service-account JSON signing or external-account/WIF JSON exchange. Use a helper for those flows, or obtain an access token in the caller. An environment access token cannot renew itself; refresh it externally for a subsequent invocation.

`google-github-actions/auth` does not automatically populate `GOOGLE_OAUTH_ACCESS_TOKEN`. Configure its `token_format: access_token`, then explicitly pass `${{ steps.auth.outputs.access_token }}` as this environment variable to the build step. Keep generated credential files outside build inputs (or exclude them). See the [Action's documented token outputs](https://github.com/google-github-actions/auth).

The build and rebase Actions accept `auth-sources`. They do not export credentials globally or automatically expose `${{ github.token }}`; pass token environment variables in the caller. The independently versioned setup Action remains responsible for installation.

