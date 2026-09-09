# v0.1.0-rc.5

This candidate hardens source packaging, OCI composition, registry recovery and supply-chain metadata following the September recheck. Supported Bun versions remain stable >=1.3.11 <1.5; target images remain Linux glibc amd64/arm64.

- Source mode honors project-local Git ignore rules, omits credential locations and rejects private-key material. Required ignored inputs fail explicitly. Review source ignore rules when upgrading: image contents can intentionally shrink.
- Preserve base directory ownership/modes by emitting only owned implicit parents. Reject nonempty base app workdirs and asset paths that traverse base links. Full verified base filesystem inspection adds read/decompression work, shared across targets in an invocation. Choose an empty workdir when composing from an application-bearing base.
- Recover bounded upload/session and idle blob-download failures, negotiate upload chunk minimums, support bracketed IPv6 and use monolithic transfers for GCR endpoints. Diagnostics retain safe OCI codes without reflecting arbitrary upstream text.
- Reuse scoped registry sessions, configure prefixed mirrors through CLI/environment/config/Action inputs and bound mirror availability retries. Authentication and integrity failures remain fatal.
- Add `--tag-conflict fail|skip` with explicit existing/skipped tag reports and verified digests. Generated standalone artifact retention tags are idempotent. Unknown provider refusal formats fail conservatively.
- Add standard base annotations, content-derived SPDX namespaces and privacy-preserving provenance inputs. Local base SPDX inventories work offline. Metadata graphs, payloads and local layout reads have cumulative and individual bounds.
- Require stable cosign 3+ before publication, retain lowercase proxy settings and redact bounded helper diagnostics. OCI-Subject acknowledgements select native referrers, delayed indexing is retried, and fallback updates serialize within a process.
- Validate host installer CA bundles consistently with or without npm cafile. Invalid or non-certificate PEM and bundles over 1 MiB now fail explicitly. Runtime CA trust is separately verified for compiled applications on both target architectures; it does not modify native system trust stores.
- Build the CLI container once by digest, execute and attest that exact index, then promote unchanged bytes to the version tag. Signed Debian snapshot packages and fixed base/helper digests make package inputs explicit.

Standard base annotations and revised layer-parent/cache rules intentionally change image and cache identities. Expect cold caches during migration. Runtime arguments now use an explicit supported option policy; unsupported or entrypoint-changing flags fail before building. Unknown Git dirty state no longer produces a clean-looking revision tag.

See the [recheck disposition](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.5/docs/RECHECK.md) for intentional contracts and follow-up features. SPDX stays opt-in outside the explicit CI policy. Independent referrer-tag publishers still require external coordination. Private ECR and remote application acceptance remain separate validation gaps. musl and rebase are tracked in issues #53 and #54; npm distribution follows this RC.

The JavaScript CLI requires Bun. Compile/runtime injection require `gpgv`. Old release assets remain immutable. The versioned container is published by a separate workflow after the CLI release; wait for it to complete before using the image tag. Existing setup defaults remain on the previously verified release until the new assets pass consumer verification.

[Candidate validation](https://github.com/sakajunquality/bunko/blob/v0.1.0-rc.5/docs/validation/rc5.md) records the exact CLI fingerprint, both-architecture runtime checks and live GAR/Docker Hub evidence. Published artifact and GHCR verification are recorded separately after release.
