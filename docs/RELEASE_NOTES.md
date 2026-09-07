# bunko v0.1.0-alpha.1

The first alpha packages the M2 preview as a standalone Bun CLI and provides a setup-bunko GitHub Action for Linux and macOS.

- Build deterministic OCI images from standalone Bun applications and workspaces.
- Publish through Docker-compatible Registry authentication, reuse dependency/asset layers, and build amd64/arm64 images.
- Choose production dependency trees or explicit runtime closures; share dependency layers across workspace targets.
- Resolve YAML/JSON image references, export OCI layouts/Docker archives, or load Docker/kind images.
- Provide an opt-in provider conformance workflow and authenticated Distribution tests.
- Include the M2 correctness fixes for starter projects, dependency packaging, transfer handling, Registry authentication, dependency closures, and input validation.

The release contains bunko.js, SHA256SUMS, and THIRD_PARTY_NOTICES.md. Bun >=1.3.11 <1.4 is required; the tested runtime is 1.3.11. There are no external npm runtime dependencies. The unminified bundle is approximately 9.2 MB and includes the YAML and TypeScript parsers with their licenses.

This is an alpha with deliberately limited Bun/lock/native-package support. GHCR and GAR have passed live publication, separate cache reuse, direct Docker pull, and amd64/arm64 runtime checks. Docker Hub account push and ECR remain unverified; their authentication paths have automated coverage. Compile mode, SBOM, provenance, signing, apply, and pruning are not included. See the specification and Registry matrix before choosing a deployment target.
