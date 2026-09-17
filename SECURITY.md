# Security policy

Bunko is alpha software. Security fixes target the latest development revision and subsequent releases; older alpha releases do not have a guaranteed backport window.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/sakajunquality/bunko/security/advisories/new) when the reporting form is available. Include the affected version, reproduction steps, expected trust boundary, and a minimal example with credentials removed. Do not include real tokens, private keys, or customer data.

If the private reporting form is unavailable, open an issue asking the maintainer to enable a private reporting channel, without vulnerability details or exploit material. Do not disclose the vulnerability in a public issue or pull request. Response times are best effort.

## Trust boundaries

Bunko builds trusted source and dependency inputs on the host. Its child-process environment and path checks are not an operating-system sandbox. Use isolated runners for untrusted projects. A project's configuration also decides what the build host connects to: `bunko.assetMappings` URL sources are fetched over HTTPS from whatever the host can reach, including private and link-local addresses, and the request precedes checksum verification. Registry, install and asset caches and their writers must be trusted; digest checks alone do not prove the claimed build inputs, though asset cache entries are re-verified against their recorded digests on every use. Metadata is self-reported unless separately verified against a trusted producer policy. Bearer token exchanges send registry credentials only to the registry origin or an allowed token-service origin. Docker Hub also trusts `https://auth.docker.io` by default; other cross-origin services require `authOrigins` in a versioned registry configuration. Anonymous token requests still follow the registry challenge. `--insecure-registry` permits HTTP for a named host and does not make credentials reaching it private; each such origin is reported on stderr.

See [metadata policy](docs/METADATA.md), [registry authentication](docs/REGISTRIES.md), and [compatibility](docs/COMPATIBILITY.md) for exact scope. Report unexpected credential disclosure, path escapes, or violations of those documented boundaries through the private channel.

## Continuous checks

The Security workflow audits the root and example Bun lockfiles on pull requests, main pushes, release-tag pushes, daily scheduled runs and manual dispatch. `bun audit` fails on any known dependency advisory; lookup failures also fail the job. Historical compatibility lockfiles under `test/fixtures` are excluded deliberately.

The workflow builds and scans the CLI container on native amd64 and arm64 runners with a commit-pinned Anchore/Grype Action. The first scan reports all findings, including those without a vendor fix. A second scan fails on high and critical findings with an available fix. Both JSON reports are retained for 14 days even when the gate fails. Unfixed findings remain visible for triage; a passing gate does not mean they are safe or resolved. Dependency audits complement container inventory scanning because minified JavaScript does not retain every package manifest. A clean scan is not a proof that the runtime or application is vulnerability-free.

Dependabot proposes weekly updates for Actions, Bun dependencies and the container base. New routine Bun dependency versions have a seven-day cooldown; updates still require review and the normal checks. Update `container/debian.sources` together with the pinned Bun base during security maintenance: rebuilding against a fixed snapshot alone cannot pick up later Debian fixes. The Dockerfile upgrades inherited OS packages against that same snapshot before installing CLI tools. Refresh the snapshot and review the base pin, inspect the scan report, run container validation and publish a new version. Do not suppress findings without documenting their applicability and a review deadline.

Scheduled checks start after this workflow is merged into the default branch. Branch protection must separately require the desired Security jobs to make them merge gates; this workflow does not change repository settings or automatically publish an image.

### Operator grants and residual host boundaries

- npm environment expansion is restricted to `BUNKO_NPM_*` or the operator's `BUNKO_NPM_CREDENTIAL_ENV` allowlist. A project still chooses the declared registry receiving an allowed credential; host matching does not establish trust. Do not grant general cloud secrets. See [npm permissions](docs/REGISTRIES.md#host-environment-permission-for-npm).
- Resolve/apply references are host project selectors. Canonical targets and workspace roots stay within `--context` by default. `--allow-external-context` explicitly permits packaging and publishing other readable projects; use it only with reviewed manifests.
- Git metadata invokes Git in the checkout, with fsmonitor/hooks disabled and system/global configuration ignored. It is optional (`--git-metadata=false`). Configuration inputs reject symlinks before parsing and redact parser failures. These checks are not a defense against a concurrently hostile process rewriting the checkout; isolate untrusted builds and keep inputs stable.
- A trusted base controls its filesystem and accounts. Do not treat its declared user, labels or metadata as independent proof of runtime safety. Explicit user choices and runtime overrides are operator responsibilities.
- Cache writers are trusted as image producers. The output repository is also the default registry cache read location when registry cache is enabled. Unsigned records supply layers, inventory and native metadata; content digests verify bytes, not truthful attribution to source inputs. Use an isolated cache repository with restricted writers.
- Prepared dependency artifacts and `layout:` inputs require explicit verification policy (`--deps-verify-key` or `--supply-chain-policy ci`) when producer authentication is needed. A digest alone authenticates no publisher.
- `--asset-context NAME=DIR` exposes that input to repository mappings. Built-in omissions and `.bunkoignore` are not general secret detection; private-key scanning applies to source mode, not every asset. Omission names are finite: files such as `.git-credentials`, `.yarnrc`, `.pypirc`, `.terraformrc`, `*.tfvars`, `*.pem`, `*.key`, `*.p12`, `credentials.json`, `.vault-token`, `.cargo/credentials.toml` and `.azure` are not all automatically excluded. Stage a minimal context and explicitly exclude sensitive files.
- URL asset fetching can reveal endpoint reachability and response fingerprints through status/checksum errors. HTTPS URLs can address private/link-local services; there is no general destination denylist. Anonymous registry token exchanges can reach HTTPS realms advertised by a registry or mirror. `authOrigins` restricts credential disclosure, not all network connections. Use runner egress policy for network isolation.
- Resource limits are not a complete host quota: decoded layers are bounded, but snapshots and layer counts are not globally bounded, and gzip/tar downloads can finish before decoded-size rejection. Apply job storage/memory/time limits. Cancellation and caches are operational controls, not a denial-of-service sandbox.
