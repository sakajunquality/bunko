# Security policy

Bunko is alpha software. Security fixes target the latest development revision and subsequent releases; older alpha releases do not have a guaranteed backport window.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/sakajunquality/bunko/security/advisories/new) when the reporting form is available. Include the affected version, reproduction steps, expected trust boundary, and a minimal example with credentials removed. Do not include real tokens, private keys, or customer data.

If the private reporting form is unavailable, open an issue asking the maintainer to enable a private reporting channel, without vulnerability details or exploit material. Do not disclose the vulnerability in a public issue or pull request. Response times are best effort.

## Trust boundaries

Bunko builds trusted source and dependency inputs on the host. Its child-process environment and path checks are not an operating-system sandbox. Use isolated runners for untrusted projects. A project's configuration also decides what the build host connects to: `bunko.assetMappings` URL sources are fetched over HTTPS from whatever the host can reach, including private and link-local addresses, and the request precedes checksum verification. Registry, install and asset caches and their writers must be trusted; digest checks alone do not prove the claimed build inputs, though asset cache entries are re-verified against their recorded digests on every use. Metadata is self-reported unless separately verified against a trusted producer policy. Bearer token exchanges send registry credentials only to the registry origin or an allowed token-service origin. Docker Hub also trusts `https://auth.docker.io` by default; other cross-origin services require `authOrigins` in a versioned registry configuration. Anonymous token requests still follow the registry challenge. `--insecure-registry` permits HTTP for a named host and does not make credentials reaching it private; each such origin is reported on stderr.

See [metadata policy](docs/METADATA.md), [registry authentication](docs/REGISTRIES.md), and [compatibility](docs/COMPATIBILITY.md) for exact scope. Report unexpected credential disclosure, path escapes, or violations of those documented boundaries through the private channel.
