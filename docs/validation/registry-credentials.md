# Registry credential source validation

GitHub, Google, Podman and local login/logout ship in bunko v0.9.0. Native AWS authentication remains deferred in #198.

## Live acceptance on September 16, 2026

The final AWS-free main commit also passed [GHCR acceptance run 35076186549](https://github.com/sakajunquality/bunko/actions/runs/35076186549), including publication, pull, private-key signing/verification and a nonroot read-only CLI container.

- [GitHub Actions acceptance run](https://github.com/sakajunquality/bunko/actions/runs/35064942508): native `github` source published and pulled an image on GHCR, signed it with an ephemeral private key, and verified it with cosign through bunko's temporary credential bridge. The Docker configuration started empty and remained unwritten. A bundled CLI in a nonroot, read-only Bun container independently pulled the image with the GitHub source. No Docker login or credential helper was used. The temporary branch-push trigger was removed after the run; the retained workflow is manual and restricted to main.
- Artifact Registry: the native `google` source published the hello fixture and pulled it using an explicit short-lived access token obtained from the existing gcloud identity. gcloud was used only to acquire that token; bunko did not invoke gcloud or a Docker helper. This validates the environment-token path, not GKE/Cloud Build metadata or WIF exchange.
- Deferred AWS work in PR #198 (not included in this release): no live AWS account was used. An actual local HTTP ECR protocol emulator exercised signed requests and refreshed registry credentials. A fixed SigV4 vector was independently generated with botocore 1.40.0. Mocked STS, ECS/Pod Identity and IMDSv2 responses exercise host restrictions, token rotation, endpoint safety, protocol headers and redacted failures. These checks do not establish IAM permissions or deployed workload identity correctness.

The GHCR run exercises private-key signing; earlier [keyless staging validation](https://github.com/sakajunquality/bunko/actions/runs/35056446363) establishes OIDC signing independently. Native registry credentials and keyless OIDC identity are separate mechanisms.

## Deferred AWS source and live acceptance

Use a dedicated test repository and least-privilege identity; do not provide root credentials or long-lived secrets in an issue/PR. Prefer an OIDC role for GitHub Actions, or an existing EKS test namespace/service account. Validate private ECR push/pull first, then an IRSA or Pod Identity workload, token rotation during a long publication, and ECR Public separately. Public ECR requires the service bearer-token permission as well as its ECR permissions. An emulator cannot certify these IAM relationships.

## Regression boundaries

Default Docker selection, helper authority and offline behavior must remain unchanged. Explicit source tests cover account fallback refusal, exact registry boundaries, temporary cosign files, credential-file exclusion, expiry and coalesced refresh. Login/logout tests cover helper store/erase, read-only or linked files, concurrent writes and preservation of unrelated settings. Podman repository-scoped credentials are deliberately rejected rather than used across a host.

Bun can retain a proxy value after environment restoration. Metadata/container and loopback credential endpoints therefore use an isolated Bun worker with no inherited proxy environment or project .env loading. Public API requests retain ordinary transport proxy behavior. The deferred AWS branch also exercises a local ECR emulator alongside proxy-related cosign tests.

## Review findings and changes

An independent Claude Fable review was checked against the implementation and focused tests. Selected helpers that return no credentials now preserve anonymous access without allowing identity fallback. Logout preserves per-host helper policy. Explicit Docker-only selection retains cosign's existing helper path instead of exporting a helper secret into a temporary file. Explicit source lookups normalize default HTTPS ports, and CLI password-stdin behavior is exercised through a subprocess. Provider request deadlines are per attempt, with at most one retry.

CodeRabbit findings about non-finite cosign credential expiry and malformed matching Docker auth entries were reproduced and fixed with regression tests. CodeRabbit reported incomplete clone-backed analysis on the foundation PR; review coverage should not be interpreted as a security certification. Temporary files used for native-source cosign integration are removed on ordinary completion and error, but a forced process termination can leave them behind; private permissions and disposable runner storage remain relevant.
