# Private development through M6

The owner requested completion through M6, followed by a researched ko gap analysis and implementation of applicable gaps. Repository visibility must remain private. Documentation and comments are English. Claude Code reviews are requested at each implementation stage when available.

## Completion gates

- [x] M3: deterministic SPDX inventory and SLSA provenance; OCI subject artifact publication/discovery and layout export; explicit private signing and verification; base inspection; Linux cross compilation; distribution smoke checks.
- [x] M4: validated external dependency artifacts; apply after complete resolution; preview-first cache pruning with explicit deletion; Distribution interoperability coverage (cloud account/policy gaps remain documented).
- [ ] M5: bounded jobs; shared content validation; reusable application output; concurrent cache safety; scale/failure regression coverage.
- [ ] M6: diagnostics and configuration usability; executable/installation guidance; runtime compatibility matrix and migration documentation; realistic project fixtures.
- [ ] Research current ko behavior using primary sources, record supported/intentional/inapplicable gaps, implement applicable high-value gaps, and verify them.
- [ ] Run complete tests, distribution and runtime checks, review changes with Claude where available, fix findings, and create reviewable PRs.

## Boundaries

No repository/package visibility changes, public transparency-log submissions, production Kubernetes changes, cloud IAM changes, or deletion of existing user images/caches are part of test execution. Mutation features are tested against disposable local fixtures. Provider checks use already authorized dedicated test repositories. Missing provider credentials are recorded as unverified rather than represented as conformance.

## Progress

- Starting point: merged PR #10, main `4198f57`; main CI passed. MIT distribution, M2, GHCR/GAR live conformance already implemented.
- Claude Code 2.1.263 is installed; a read-only design review has been requested.
- M3 is PR #11. Claude findings were fixed; CI passed. See M3_REVIEW.md.
- M4 passed amd64/arm64 external-artifact runtime checks, disposable kind apply, and real Distribution tag deletion with runnable-image retention. Claude findings were fixed; see M4_REVIEW.md.
- M5 performance and concurrent cache work is next.
