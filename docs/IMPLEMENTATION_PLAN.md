# Private development through M6

The owner requested completion through M6, followed by a researched ko gap analysis and implementation of applicable gaps. Repository visibility must remain private. Documentation and comments are English. Claude Code reviews are requested at each implementation stage when available.

## Completion gates

- [x] M3: deterministic SPDX inventory and SLSA provenance; OCI subject artifact publication/discovery and layout export; explicit private signing and verification; base inspection; Linux cross compilation; distribution smoke checks.
- [x] M4: validated external dependency artifacts; apply after complete resolution; preview-first cache pruning with explicit deletion; Distribution interoperability coverage (cloud account/policy gaps remain documented).
- [x] M5: bounded jobs; shared content validation; reusable application output; concurrent cache safety; scale/failure regression coverage.
- [x] M6: diagnostics and configuration usability; executable/installation guidance; runtime compatibility matrix and migration documentation; realistic project fixtures.
- [x] Research current ko behavior using primary sources, record supported/intentional/inapplicable gaps, implement applicable high-value gaps, and verify them.
- [x] Run complete tests, distribution and runtime checks, review changes with Claude where available, fix findings, and create reviewable PRs.

## Boundaries

No repository/package visibility changes, public transparency-log submissions, production Kubernetes changes, cloud IAM changes, or deletion of existing user images/caches are part of test execution. Mutation features are tested against disposable local fixtures. Provider checks use already authorized dedicated test repositories. Missing provider credentials are recorded as unverified rather than represented as conformance.

## Progress

- Starting point: merged PR #10, main `4198f57`; main CI passed. MIT distribution, M2, GHCR/GAR live conformance already implemented.
- Claude Code 2.1.263 completed read-only design, milestone and ko-gap reviews, plus a focused follow-up; actionable findings were fixed.
- M3 is PR #11. Claude findings were fixed; CI passed. See M3_REVIEW.md.
- M4 passed amd64/arm64 external-artifact runtime checks, disposable kind apply, and real Distribution tag deletion with runnable-image retention. Claude findings were fixed; see M4_REVIEW.md.
- M5 adds bounded target jobs, invocation-local syntax memoization and application layers, with verified local writer conflicts. See PERFORMANCE.md and M5_REVIEW.md.

- M6 adds offline diagnostics, command-specific flag checks and SQLite examples; Bun 1.3.11/1.3.12 each passed bundle/compile runtime checks on amd64/arm64. See COMPATIBILITY.md and validation/m6-runtime.json.

## Delivered PR stack

All five PRs were merged in dependency order on 2026-09-08 JST; repository visibility remains private.

| Phase | PR | Main additions |
| --- | --- | --- |
| M3 | [#11](https://github.com/sakajunquality/bunko/pull/11) | SBOM/provenance, OCI artifacts, private signing, compile and base checks |
| M4 | [#12](https://github.com/sakajunquality/bunko/pull/12) | Prepared dependencies, apply, local/remote prune and layout publication |
| M5 | [#13](https://github.com/sakajunquality/bunko/pull/13) | Bounded jobs, syntax memoization, application caching and cache concurrency |
| M6 | [#14](https://github.com/sakajunquality/bunko/pull/14) | Diagnostics, strict option routing, compatibility matrix and SQLite examples |
| ko gaps | [#15](https://github.com/sakajunquality/bunko/pull/15) | Metadata flags/annotations, reference files, selectors and conventional data |

The private GHCR fixture update is [bunko-test #1](https://github.com/sakajunquality/bunko-test/pull/1). That PR and the five implementation PRs were merged after explicit owner authorization. Main CI and GHCR conformance passed. No public release was created.

The final local suite has 213 passing tests. Docker checks covered both image architectures and bundle/compile modes; disposable kind validated selector apply and Distribution validated cache pruning without deleting the runnable image. GHCR/GAR each verified three OCI metadata attachments and six private signatures. Source and prepared-distribution secret scans found no findings. See KO_REVIEW.md, LIVE_REGISTRY_VALIDATION.md and the per-milestone review documents for evidence and limits. Docker Hub/ECR account-specific validation remains unverified; deliberate ko differences are listed in KO_GAPS.md.
