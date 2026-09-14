# Security policy

Bunko is alpha software. Security fixes target the latest development revision and subsequent releases; older alpha releases do not have a guaranteed backport window.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/sakajunquality/bunko/security/advisories/new) when the reporting form is available. Include the affected version, reproduction steps, expected trust boundary, and a minimal example with credentials removed. Do not include real tokens, private keys, or customer data.

If the private reporting form is unavailable, open an issue asking the maintainer to enable a private reporting channel, without vulnerability details or exploit material. Do not disclose the vulnerability in a public issue or pull request. Response times are best effort.

## Trust boundaries

Bunko builds trusted source and dependency inputs on the host. Its child-process environment and path checks are not an operating-system sandbox. Use isolated runners for untrusted projects. A project's configuration also decides what the build host connects to: `bunko.assetMappings` URL sources are fetched over HTTPS from whatever the host can reach, including private and link-local addresses, and the request precedes checksum verification. Registry, install and asset caches and their writers must be trusted; digest checks alone do not prove the claimed build inputs, though asset cache entries are re-verified against their recorded digests on every use. Metadata is self-reported unless separately verified against a trusted producer policy. A registry also chooses its own token service: a Bearer challenge's `realm` decides which host receives the credential configured for that registry, so a compromised registry can direct its own credential to another host it names. `--insecure-registry` permits HTTP for a named host and does not make credentials reaching it private; each such origin is reported on stderr.

See [metadata policy](docs/METADATA.md), [registry authentication](docs/REGISTRIES.md), and [compatibility](docs/COMPATIBILITY.md) for exact scope. Report unexpected credential disclosure, path escapes, or violations of those documented boundaries through the private channel.

## Continuous checks

The Security workflow audits the root and example Bun lockfiles on pull requests, main pushes, release-tag pushes, daily scheduled runs and manual dispatch. `bun audit` fails on any known dependency advisory; lookup failures also fail the job. Historical compatibility lockfiles under `test/fixtures` are excluded deliberately.

The workflow builds and scans the CLI container on native amd64 and arm64 runners with a commit-pinned Anchore/Grype Action. The first scan reports all findings, including those without a vendor fix. A second scan fails on high and critical findings with an available fix. Both JSON reports are retained for 14 days even when the gate fails. Unfixed findings remain visible for triage; a passing gate does not mean they are safe or resolved. Dependency audits complement container inventory scanning because minified JavaScript does not retain every package manifest. A clean scan is not a proof that the runtime or application is vulnerability-free.

Dependabot proposes weekly updates for Actions, Bun dependencies and the container base. New routine Bun dependency versions have a seven-day cooldown; updates still require review and the normal checks. Update `container/debian.sources` together with the pinned Bun base during security maintenance: rebuilding against a fixed snapshot alone cannot pick up later Debian fixes. The Dockerfile upgrades inherited OS packages against that same snapshot before installing CLI tools. Refresh the snapshot and review the base pin, inspect the scan report, run container validation and publish a new version. Do not suppress findings without documenting their applicability and a review deadline.

Scheduled checks start after this workflow is merged into the default branch. Branch protection must separately require the desired Security jobs to make them merge gates; this workflow does not change repository settings or automatically publish an image.
