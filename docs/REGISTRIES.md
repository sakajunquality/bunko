# Registry configuration and verification status

Bunko implements OCI Distribution push/pull and Docker-compatible credentials. Cloud SDKs are not bundled: use an authenticated Docker config or credential helper. bunko does not create repositories or change cloud IAM.

## Support matrix

| Registry | Example `--repo` prefix | Authentication | Verification status |
| --- | --- | --- | --- |
| GitHub Container Registry | `ghcr.io/OWNER` | Docker login, PAT, or workflow token | Live workflow-token push, separate cache reuse, direct Docker pull, and amd64/arm64 runtime verified. [Report](LIVE_REGISTRY_VALIDATION.md). |
| Google Artifact Registry | `asia-northeast1-docker.pkg.dev/PROJECT/REPOSITORY` | gcloud/gcr helper or access token | Live helper-authenticated push, separate cache reuse, direct Docker pull, and amd64/arm64 runtime verified. [Report](LIVE_REGISTRY_VALIDATION.md). |
| Docker Hub | `docker.io/USERNAME` | Docker login or credential store | Published alpha.2: account push, cache reuse, direct Docker pull and amd64/arm64 runtime checks passed. See [release validation](PUBLISHED_RELEASE_VALIDATION.md). |
| Amazon ECR private | `ACCOUNT.dkr.ecr.REGION.amazonaws.com/PREFIX` | ecr-login helper or AWS password | Automated helper/Basic-challenge/credential-refresh tests; real service push not verified. |
| OCI Distribution | `localhost:5000/demo` | Basic, Bearer, or anonymous | Real push/pull, cache reuse, and container execution with Distribution 3. |

bunko appends `bunko.imageName` or the project name to the prefix. For an exact repository, use `--bare`, for example `--repo docker.io/USERNAME/app --bare`. Create GAR projects/repositories and exact ECR image repositories beforehand. ECR Public, Harbor-specific extensions, referrers, and signing require separate validation.

Cloud publication tests require a user-selected repository and permissions. GHCR, GAR and Docker Hub have linked live results; private ECR remains unverified. Passing mock tests does not establish interoperability with a cloud service.

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

Cache tags use `bunko-cache-v1-<kind>-<full-key>` for app, deps, assets and runtime layers, defaulting to the image repository. Use `--cache-repo` or `BUNKO_CACHE_REPO` for a separate cache repository. Typed `--cache-to type=registry,repo=REPO` adds explicit cache exports; see [cache distribution](CACHE_RETENTION.md) for destination precedence and local backends. Unsupported custom OCI artifacts or denied cache writes warn by default; `--cache-export-error=fail` fails after recording outcomes without undoing successful image publication. Disable Registry caching with `--no-registry-cache`.

Blob placement uses HEAD, then an available same-Registry cross-repository mount, then upload. Uploads normally use 8 MiB chunks and offset reconciliation. GHCR and Artifact Registry use a streamed, full-file PUT. Live tests observed GHCR rejecting the ranged PATCH and Artifact Registry rejecting a second chunk. Interrupted full-file PUTs are checked by digest before retrying in a fresh session; permanent permission failures are not retried. [Artifact Registry API support](https://docs.cloud.google.com/artifact-registry/docs/reference/docker-api) Publish platform manifests and the index by digest before updating tags. Multiple tags are not transactional: `--report` records published digests/tags and pendingTags on failure, with exit 1 and empty stdout. Existing tags are not rolled back.

Registry credentials and npm credentials are separate. Private npm uses HTTPS registry/scoped-registry configuration and `${ENV_NAME}` credentials from project .npmrc. Authentication files exist only in install staging and are removed afterward; values do not enter cache keys, images, or reports.

## Opt-in service conformance

After merging the workflow, select **Actions → Registry conformance → Run workflow** and supply a provider plus a fully qualified, dedicated image repository. The workflow validates that the host matches the selected provider before authentication. It builds amd64/arm64, publishes unique image tags, edits the source, checks dependency/asset reuse, pulls through a fresh client, and runs the amd64 image through Docker. It also exports Docker's stored config and verifies its digest; Docker's displayed image ID can represent an index or manifest depending on the image store.

Configure only the provider you intend to run:

| Provider | Repository variables | Repository secrets / identity |
| --- | --- | --- |
| GHCR | Optional GHCR_USERNAME | GITHUB_TOKEN by default; optional GHCR_TOKEN for a different authorized identity |
| GAR | GAR_WORKLOAD_IDENTITY_PROVIDER, GAR_SERVICE_ACCOUNT | Workload Identity Federation with service-account access to the selected GAR repository |
| Docker Hub | DOCKERHUB_USERNAME | DOCKERHUB_TOKEN with push access to the dedicated repository |
| ECR private | AWS_ROLE_ARN | GitHub OIDC trust and ECR permissions for the selected account/repository; region/account are derived from the destination |

The workflow uses the official [Docker login action](https://github.com/docker/login-action), [Google authentication action](https://github.com/google-github-actions/auth), [AWS credentials action](https://github.com/aws-actions/configure-aws-credentials), and [ECR login action](https://github.com/aws-actions/amazon-ecr-login), pinned to commits. Create repositories and configure permissions beforehand. Supply a separate cache repository on the same host to exercise cross-repository cache reuse, or leave it empty to use the image repository. ECR repositories must allow the distinct cache/image tags created by repeated runs.

The default requires verified Registry cache hits. Disable that requirement only to test publication/runtime on a provider without usable custom cache artifacts; the report still marks cache verification false. A successful publication-only run must not be recorded as cache conformance.

For local execution with existing Docker credentials:

```sh
BUNKO_SMOKE_VENDOR=ghcr \
BUNKO_SMOKE_REPO=ghcr.io/OWNER/bunko-conformance \
BUNKO_SMOKE_REPORT=/tmp/bunko-ghcr-report.json \
bun run test:registry
```

The report path must be new. Both clients use DOCKER_CONFIG; BUNKO_DOCKER_CONFIG is rejected by this harness to prevent mismatched authentication. Optional variables are BUNKO_SMOKE_CACHE_REPO, BUNKO_SMOKE_REQUIRE_CACHE (true/false), BUNKO_SMOKE_PLATFORMS (runtime platforms, default linux/amd64), and BUNKO_SMOKE_NPM_CACHE. Every run still builds both image platforms.

Runs retain remote `bunko-smoke-<UUID>-first` / `-warm` image tags and `bunko-cache-v1-*` cache tags in the supplied repositories. Reports identify those tags and any partial publication. The harness removes only its own local containers/images/temp files; remote retention or deletion is managed separately. Reports include publication, payload transfers, cache verification, verified descriptors, native runtime responses, and shutdown results. The workflow uploads available reports even on failure.

Token expiry, permission changes during a run, private npm services, referrers, and provider-specific policy combinations remain separate tests. Only provider rows with linked live results establish service interoperability; the remaining rows are unverified.

## Authenticated local conformance

```sh
bun run test:registry-local
```

This starts a disposable Distribution 3 Registry with Basic authentication, rejects anonymous/wrong-password requests, then uses the same conformance harness with a separate cache repository. CI directly pulls and runs linux/amd64 with Docker. On macOS, the harness uses a digest-verified host pull and Docker archive load because Docker Desktop cannot reach the host's loopback Registry in the validated environment. Reports distinguish that path with `directDockerPull:false`; it does not establish direct Docker pull conformance.

Prerequisite Docker pulls retry transient 429/5xx and connection failures at most three times. Container creation is not retried. This addresses an observed Docker Hub 500 while starting the merged-main CI job; rerunning that original job succeeded.

Local validation on 2026-09-08 passed with authenticated Distribution 3, separate image/cache repositories, and both amd64/arm64 runtime checks on macOS. Cache reuse was verified, both Docker-exported config digests matched, and both nonroot/read-only containers exited 0 on SIGTERM. This run used the archive path, not direct Docker pull. The Linux CI run exercises direct Docker pull separately.

## Private CA and mutual TLS

`--registry-config FILE` accepts a JSON object keyed by registry host, optionally including a port. Each value accepts `ca`, `cert` and `key` PEM file paths relative to that JSON file. Client authentication requires cert and key together. Default-port aliases are normalized and duplicate hosts fail. For example:

```json
{"registry.example.com:443":{"ca":"ca.pem","cert":"client.pem","key":"client-key.pem"}}
```

Certificates are scoped to exact HTTPS origins, including separately configured token-service origins. Redirects do not forward a client certificate to an unconfigured origin. TLS verification remains enabled. `--insecure-registry HOST:PORT` means explicit HTTP permission, not disabled HTTPS verification. Configuration and certificate files are excluded from application snapshots; keep them outside the project whenever possible.

This config controls Bunko's OCI client. Combining it with integrated signing is rejected before publication; publish first and sign using a separately configured cosign client. Configure cosign's trust separately (for example with its supported SSL_CERT_FILE environment); it does not consume this JSON file. Pull mirrors are configured separately with `--registry-mirror`.

## Dependency installer proxies and private npm CAs

rc.4 and later forward `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lowercase forms to isolated Bun installers. Bun selects the proxy and bypass rules; Bunko preserves explicit empty values and does not inherit unrelated host execution settings. Registry fetches use Bun's native proxy environment handling. Proxy credentials are transport inputs, not image configuration.

An application or workspace root `.npmrc` may specify `cafile=certs/npm-ca.pem`. Relative paths resolve against that original root, not the temporary installation directory. `${VARIABLE}` expansion is explicit. The input must contain valid PEM certificates and be at most 1 MiB. Bundle annotations are allowed; private keys and other PEM blocks are rejected. The file is excluded from source and asset staging, and the installer receives a temporary private copy that is removed afterward. Host trust material is not automatically installed into the application image.

`NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` remain available to installers, with relative host paths resolved before changing directories. When npm `cafile` is configured, its certificates are combined with `NODE_EXTRA_CA_CERTS` for process-level trust as well as passed through Bun's `--cafile`: Bun 1.3.11 requires process-level trust inside CONNECT tunnels. Existing extra certificates are preserved. Every actual dependency install validates nonempty `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` as readable certificate-only PEM bundles of at most 1 MiB, whether or not npm `cafile` is configured. Empty values preserve the caller override. `SSL_CERT_DIR` is not forwarded by the isolated Bun installer; use a PEM bundle. Cache hits that do not install need no host trust validation. TLS verification remains enabled. Inline npm `ca` settings and `strict-ssl=false` are not accepted.

Certificate bytes, certificate paths and proxy credentials are excluded from dependency content-cache metadata and successful reports. Offline diagnostics validate the presence/shape of the cafile setting without requiring credential environment values or opening the certificate. Build preparation validates the actual bundle before network activity. The immutable rc.3 CLI does not include this support.

Validation uses a local HTTPS npm registry and a separate tarball server with distinct private test CAs, plus an HTTP CONNECT proxy. Actual Bun installs succeed through that proxy, and `NO_PROXY=localhost` bypasses it with a fresh package cache. See [Bun npmrc support](https://bun.sh/docs/pm/npmrc) and [Bun proxy configuration](https://github.com/oven-sh/bun/blob/main/docs/guides/http/proxy.mdx).

## Pull mirrors

rc.4 and later accept repeatable `--registry-mirror ORIGIN=MIRROR` for build, resolve, apply, check-base and metadata. The immutable rc.4 accepts host-only endpoints. Current development also accepts an optional repository prefix: `docker.io=us-docker.pkg.dev/example-project/cache` maps `library/app` to `example-project/cache/library/app`. Endpoints must not include a URL scheme or credentials. Docker Hub aliases normalize to `registry-1.docker.io`.

```sh
bunko build . --registry-mirror docker.io=mirror.example.com --push=false --oci-layout output
```

Tags are always resolved at the origin. Once a digest is known, Bunko tries the configured mirrors in order, then the origin. Digest-pinned roots can be fetched directly from a mirror. A missing object, exhausted connection retries (including TLS connection failures), rate limiting or server error allows fallback; the CLI reports the skipped mirror and reason without credentials. Authentication/policy errors, corrupt content and exhausted body recovery fail the operation. Digest and size verification remains mandatory when content is consumed.

Each mirror uses its own Docker credential lookup, tokens and host-scoped TLS settings. No origin Authorization header is forwarded to a mirror. Mirrors receive only pull operations; publication and cache writes use their explicit destination. Configure `--registry-config` and `--insecure-registry` for the actual mirror host if needed. A mirror is a content source, not a replacement for origin availability when resolving mutable tags. The immutable rc.3 CLI does not include this option.


## Failure recovery and diagnostics

Changes after rc.4 renew a cached, expired scoped token before transmitting another request body. Bearer challenges accept quoted or unquoted parameters and reject duplicate parameter names. Authentication remains scoped to the original registry; redirects do not receive its Authorization header.

Chunked uploads query the committed offset after transient failures and back off before recovery. A missing or expired session (404/410) starts again from byte zero, with a separate bound on session restarts even when earlier chunks succeeded. Permission, TLS-policy and local validation errors fail immediately. Upload-session creation alone can retry transient POST failures; other POST operations do not acquire blanket replay behavior. A lost session-creation response may leave an empty registry-managed session for garbage collection. Transient mount failures can fall back to uploading the verified local blob.

Successful finalization responses in the 2xx range are accepted only with subsequent blob existence/digest-size checks or exact manifest-byte verification. This tolerates providers with nonstandard success codes without treating the status alone as proof of publication.

Terminal errors retain recognized [OCI Distribution error codes](https://github.com/opencontainers/distribution-spec/blob/main/spec.md#error-codes), such as `DENIED` or `MANIFEST_UNKNOWN`. Error responses are bounded to 64 KiB and one second. Arbitrary upstream messages, details, and unknown codes are omitted because they may echo credentials, signed URLs, or private input. Offline transport policy errors retain their explicit diagnostic and bypass connection retries. These changes do not alter the immutable rc.4 release.


Digest-addressed blob downloads have a two-minute idle deadline between body chunks, rather than a total transfer deadline. Interrupted or truncated bodies get at most three recovery requests with backoff. Recovery requests use `Range`; a server that ignores it can return the full object, whose already-received prefix is discarded. `Content-Range`, declared lengths/digests, final size and complete blob hash are checked. Invalid response metadata and oversized payloads fail immediately. Partial files are never accepted into the blob store. This body recovery is separate from the bounded GET/HEAD header retry policy and does not resume manifest JSON transfers.

Registry references, insecure allowlists, mirror hosts, and TLS configuration keys accept bracketed IPv6 literals, such as `[::1]:5000/team/app:tag`. Unbracketed literals and zone identifiers are rejected. Credentials remain scoped to the configured registry authority.

Uploads use 8 MiB chunks by default and honor a session's `OCI-Chunk-Min-Length` up to a 32 MiB buffer limit. Larger or malformed advertised minimums select a streamed monolithic PUT instead of allocating a registry-controlled buffer. New upload sessions renegotiate their minimum; replayed monolithic transfers stay monolithic. GHCR, Artifact Registry Docker endpoints, and migrated `gcr.io`, `us.gcr.io`, `eu.gcr.io`, and `asia.gcr.io` endpoints use monolithic uploads. Completion still requires verified remote digest/size evidence.


`--tag-conflict fail|skip` controls explicit immutable-tag refusals for build, resolve, apply and push-layout. The default `fail` retains fatal publication errors. With `skip`, a tag already pointing at the desired digest needs no write; `existingTags` records it. Mutable tags can still move normally. An explicitly classified immutable refusal is skipped only after a verified read confirms the existing tag digest; `skippedTags` records that digest and the HTTP status, while `tags` contains only tags pointing at the new image. The image remains available through its published digest even when a tag was skipped. Generic 400/403/405/409/412 errors and missing/unreadable tags remain fatal. Unknown registry-specific refusal formats fail conservatively. Upstream message text is used only for bounded classification and is never reflected in diagnostics or reports.

After a successful write, blob HEAD and manifest readback permit up to three delayed-visibility retries with backoff. Exact digest/size or manifest bytes remain required; retry exhaustion fails publication. This does not provide atomic tag updates or protect against another publisher moving a mutable tag later.

Re-publishing an already-correct immutable tag also requires `--tag-conflict skip`; the default fail mode does not pre-read tags. `push-layout` assigns a standalone artifact a stable `bunko-artifact-sha256-<digest>` retention tag when no tag is supplied. This generated content-addressed tag automatically accepts an existing identical digest, but an immutable refusal retaining another digest fails. Explicit tags replace this default and follow the selected conflict policy; ordinary image layouts retain their existing tag behavior.

Mirror GET/HEAD requests use at most one retry, a five-second response-header deadline, and at most 250 ms backoff (including Retry-After). An unavailable mirror is skipped for the rest of the build invocation after its retry budget is exhausted. A 404 cache miss does not disable later digest lookups. Fallback is logged once per mirror client. Authentication and content failures remain fatal, including an unavailable mirror token service. Token exchange retains its separate 30-second deadline; the short mirror header/retry budget applies to registry content requests. These limits do not relax verification or authentication policy.

Readers and publishers reuse registry clients and scoped tokens within a build. Library callers using the internal transport APIs must treat a shared RegistryOptions object as immutable; a new options object creates a separate session and resets mirror availability state. Repository prefixes affect read paths and token scopes, while credential helpers and TLS settings still use the mirror host alone.


Mirrors can also be set with `BUNKO_REGISTRY_MIRRORS` (one `ORIGIN=HOST[/PREFIX]` per line), the build Action's `registry-mirrors` input, or a versioned `--registry-config` file:

```json
{
  "schemaVersion": 1,
  "tls": {},
  "mirrors": { "docker.io": ["us-docker.pkg.dev/example-project/cache", "mirror.example.com"] }
}
```

The existing host-to-certificate JSON format remains supported. Versioned configuration rejects unknown fields. Explicit `--registry-mirror` flags replace the entire environment/config mirror list; a present environment variable replaces the config list, including an empty variable to disable it. The TLS portion is independent of this precedence. Mirror routing applies to RegistrySource reads, including base preparation, registry cache reads, prepared dependencies and base SBOM inputs; it never changes publication destinations.
A resumed blob can be served by a different configured mirror; only the final verified digest and size permit acceptance. Consumer cancellation interrupts pending reads and recovery backoff without starting another body recovery request.
