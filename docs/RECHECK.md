# September 2026 recheck disposition

This record separates correctness repairs from feature proposals and intentional contracts. It applies to the current main branch after the linked changes are merged; it does not retroactively change rc.4 or certify an external application's workload. Release validation identifies exact published bytes separately.

## Correctness and interoperability repairs

| Area | Resolution and evidence |
| --- | --- |
| Source packaging | Source mode honors project-local Git ignore rules, omits credential locations and rejects private-key material. Required excluded inputs fail explicitly. [#55](https://github.com/sakajunquality/bunko/pull/55) includes regression and two-architecture application fixtures. |
| Layer metadata and layouts | Only owned implicit directories replace base metadata; collisions are checked before archive creation. Prepared platform aliases deduplicate correctly, layout references are consumable and descriptor annotations survive import. [#52](https://github.com/sakajunquality/bunko/pull/52). |
| Base filesystem | App/dependency workdirs must be empty, generic assets cannot traverse base links, and deep archive paths are bounded. Full verified base inspection is shared within a build and its cost is documented. [#59](https://github.com/sakajunquality/bunko/pull/59). |
| Registry recovery | Bounded/redacted errors, explicit offline policy errors, token refresh, upload recovery, negotiated chunk minimums, monolithic GCR transfers, IPv6, cancellable idle/Range pull recovery and verified readback. [#56](https://github.com/sakajunquality/bunko/pull/56), [#61](https://github.com/sakajunquality/bunko/pull/61), [#62](https://github.com/sakajunquality/bunko/pull/62). |
| Mirrors | Shared clients and scoped tokens, short header/retry budgets, invocation-level availability state, repository prefixes and config/environment/Action inputs. [#63](https://github.com/sakajunquality/bunko/pull/63). |
| Tag policies | Explicit immutable refusals can be skipped with a verified existing digest; unknown errors remain fatal. Generated artifact retention tags accept repeated identical publication. [#64](https://github.com/sakajunquality/bunko/pull/64). |
| Runtime and defaults | Runtime argv is validated, inherited workspace leaf keys are visible, and unknown Git dirty state cannot generate a clean-looking revision tag. [#57](https://github.com/sakajunquality/bunko/pull/57), [#65](https://github.com/sakajunquality/bunko/pull/65). |
| Metadata | Content-derived SPDX namespaces, canonical provenance subjects, privacy-preserving build parameters, standard base annotations and offline local base inventories. Graph and local metadata reads are bounded. [#58](https://github.com/sakajunquality/bunko/pull/58), [#65](https://github.com/sakajunquality/bunko/pull/65). |
| Signing and attachments | Pre-publication cosign version guard, bounded/redacted helper diagnostics, lowercase proxy handling, OCI-Subject capability detection, delayed referrer visibility and in-process fallback serialization. [#66](https://github.com/sakajunquality/bunko/pull/66), [#67](https://github.com/sakajunquality/bunko/pull/67). |
| Container release | Build once by digest, execute both architectures, attest and verify that exact index, then promote its unchanged bytes. Signed Debian snapshot packages, fixed base/helper digests and publication serialization. [#60](https://github.com/sakajunquality/bunko/pull/60). |
| Host trust and coverage | Nonempty installer CA inputs are validated consistently with or without npm cafile. Asset exclusion tests use files that are not already omitted by policy; toolchain revision/integrity-suffix and CA traversal cases have explicit tests. [#68](https://github.com/sakajunquality/bunko/pull/68). |

Reviews combine local Codex inspection, Claude review and CodeRabbit when available. Rate-limited or absent bot responses are not approvals. Findings discovered during review receive their own tests; CI and real-runtime evidence are recorded with each PR.

## Retained contracts

- Source mode packages all permitted project source inputs. Bundle/compile mode can still use an asset-excluded file as a build input. Neither ignore rules nor these checks make host execution a security sandbox.
- Mirror authentication and content-integrity failures are fatal. An availability fallback does not weaken origin or mirror credential scope. Mirror header budgets do not cover a separate token-service exchange; exhausted stalled-body recovery remains fatal.
- Runtime CA injection extends Bun/Node trust through `NODE_EXTRA_CA_CERTS`. It does not install a system certificate store or promise trust for arbitrary native subprocesses. Automatically replacing `SSL_CERT_FILE` could discard a consumer's existing public roots; that behavior is not added implicitly.
- SPDX generation stays opt-in, except where the explicit CI policy requires it. Its scope is application/runtime inventory plus explicitly linked base documents, not an OS scanner.
- Reproducible metadata retains the configured source epoch, including the epoch-zero default. A historical creation time is a reproducibility choice, not a claim of wall-clock execution time.
- The SLSA builder ID identifies Bunko logically. `builderDependencies` and internal parameters carry the concrete builder digest. These are self-reported statements, not a claimed SLSA assurance level.
- `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` is already a generated-image default; the older report's missing-default observation does not apply to current code.
- `--target .` intentionally selects a workspace root application. Bun `packageManager` declarations require exact supported versions; integrity suffixes and prereleases remain explicitly rejected.
- OCI referrer fallback tags are not universally transactional across independent processes. Coordinate writers externally. Local serialization and readback cannot prevent a later external overwrite.

## Follow-up implementation order

1. rc.5 CLI and container publication and independent consumer verification are complete; see [validation evidence](validation/rc5.md). Resume the private GHCR application conformance run after the owner resolves the GitHub billing restriction. npm/bunx distribution and local installation/upgrade/rollback tests are implemented; [rc.5 publication](validation/npm-rc5.md) passed consumer verification. Verify the first OIDC publication and cross-version registry upgrade/rollback with the next release. Preserve previous release assets.
2. Expand supply-chain consumption: recursive/platform and attachment signature verification, opt-in DSSE attestations, scanner-compatible SBOM discovery/export, index inventory and CycloneDX. Define the exact consumer contract before changing defaults or claiming scanner compatibility.
3. Complete dedicated private ECR and provider-specific immutable/referrer policy validation. Add effective mirror-serving diagnostics without exposing signed URLs or credentials. Generic Distribution fixtures do not certify every cloud registry policy.
4. Extend CI integration inputs and deployment recipes, then prioritize cache TTL, additional destinations, remote contexts and telemetry propagation/protobuf using workload evidence. Existing OpenTelemetry JSON export is implemented; a history service is not.
5. Implement [musl support #53](https://github.com/sakajunquality/bunko/issues/53) and [safe rebase #54](https://github.com/sakajunquality/bunko/issues/54) under their explicit compatibility gates.

General Dockerfile/LLB/RUN execution, remote workers, operating-system package management, arbitrary secret/SSH build steps, Windows images and buildpacks remain outside Bunko's source-to-image scope. The remote application acceptance matrix must still be run on its owning machine; synthetic fixtures are not a substitute.


## Additional runtime evidence

On 2026-09-09, the compile CA fixture passed on Linux amd64 and arm64 with host Bun 1.4.2 (revision `744846f84`) and authenticated release compilers. Each nonroot, read-only container verified its private loopback TLS endpoint without external networking. This verifies declared Bun TLS trust, not native-client system stores. The fixture requires Docker with support for the selected target platforms and OpenSSL with `req -addext`; select fewer targets with `BUNKO_SMOKE_PLATFORMS` when emulation is unavailable.
