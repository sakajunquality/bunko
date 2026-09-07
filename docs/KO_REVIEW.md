# ko workflow review and final validation

Claude Code 2.1.263 reviewed the researched gap plan and implementation with read-only tools. The following findings were fixed:

- Selector output no longer adds a YAML 1.2 directive, which kubectl's YAML reader rejected. A disposable kind cluster subsequently passed server dry-run and real apply **with a selector**, not just a JavaScript parser round trip.
- YAML merge keys are enabled for label evaluation, including aliased/merged metadata. Quoted `<<` remains an ordinary key.
- Null/comment-only documents do not match negative selectors.
- Only metadata labels are converted to JavaScript for selection. Unrelated repeated aliases do not consume the label expansion budget.
- Float tokens retain their original lexical representation through custom scalar tags, avoiding JavaScript rounding during YAML normalization. Integers use BigInt. Default resolution remains source-preserving.
- Names excluded by the source policy now produce an explicit error inside selected bunkodata roots, rather than silently disappearing. Output/cache exclusions inside those roots also fail.
- Explicit jobs, repository syntax and signing-tool options are checked even when no documents match.

One proposed change was intentionally declined: requiring a repository when there are no image references. Resolve/apply already support ordinary ConfigMaps and filtered empty streams without a registry. No images means no repository is needed; explicitly supplied invalid execution options still fail. Explicit directives already present in the user's YAML retain their existing semantics; the selector adds no new version directive.

Validation includes the full Bun 1.3.11/1.3.12 suites, Linux/macOS CI, deterministic metadata assertions, overwrite/partial-publication reference files, selector merge/alias/null/precision cases, conventional-data invalidation and exclusion errors, and bundle/compile Docker execution on amd64/arm64. Distribution pruning removed the two test cache records while retaining the runnable image. The disposable kind apply test passed. Gitleaks 8.30.1 found no secrets in an exported source snapshot or the prepared distribution; these scans are evidence for those artifacts, not a guarantee about every future change.

Dedicated GHCR and GAR tests each published both platform images and three SPDX/provenance attachments and verified all six private signatures with cosign 3.1.3. See LIVE_REGISTRY_VALIDATION.md and the associated immutable reports. Docker Hub account push, ECR private and other provider policies remain unverified.
