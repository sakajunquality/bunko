# Operations validation and review

Validated privately on 2026-09-08 with Bun 1.3.11, Distribution 3, and a disposable kind v0.33.0 cluster.

- Prepared dependency artifacts produced deterministic images that ran on linux/amd64 and linux/arm64.
- Artifact tests check local and Registry imports, lock/platform mismatches, ready-to-run packages with unexecuted install scripts, and inventory reconstruction.
- Tar tests cover PAX names, internal links, escaping links, file/parent overlap, truncation, size budgets, preexisting output trees, and multi-chunk file integrity.
- Server-side Kubernetes dry-run and actual apply succeeded in the dedicated cluster. The cluster and its separate kubeconfig were removed afterward. Unit tests verify no kubectl invocation after resolution failure, preservation of kubectl exit/output, and report-write races.
- Real Distribution 3 tag-only pruning succeeded; the runnable image remained available. Tests verify remote ownership checks, refusal of unsupported tag deletion without digest fallback, local shared-blob retention, unshared-blob removal, and symlinked-cache refusal.
- Claude Code reviewed tar extraction, artifact import, apply, pruning, cache locks, and integration. No extractor path-traversal flaw was identified in that review.

Review fixes preserve partial resolve reports inside apply reports; delete selected blobs before keys for crash recovery; remove reader-exclusive cache locks; surface writer lock/permission diagnostics; skip republishing Registry cache hits; restrict dependency artifacts to build until per-target resolve mappings exist; tolerate omitted empty tag lists; request delete scope only for deletion; use explicit file-write offsets; reject pre-populated extraction trees; preserve kubectl output on report failure; validate prune age text; report post-discovery single-target build failures; and share workdir validation.

Local retention intentionally uses record modification time, not last-use time. Unknown orphan blobs are retained conservatively. Cache writers and pruning cooperate through a lock; verified readers tolerate concurrent removal as a cache miss. Processes using older versions must not write the same cache while pruning.

Cloud tag-deletion policies and Docker Hub/ECR account publication remain separate provider checks. No cloud IAM, production resources, or repository visibility settings were changed.
