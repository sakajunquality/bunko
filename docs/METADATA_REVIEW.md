# Metadata and producer policy review

Claude performed a read-only source review and a follow-up review. Targeted regressions cover layout and registry fallback export, native referrers pagination, mismatched subjects, exact payload digests, base SPDX linkage, policy preflight and signing key exclusions.

Changes from the initial review:

- Base inventories must bind to the selected platform manifest; index subjects are insufficient.
- SPDX external references include relationships to packages explicitly described by the base document. Namespace URIs are validated.
- Unrelated artifact envelopes and predicates can coexist; digest or subject corruption remains fatal.
- The cache packing version changes with inventory semantics, preventing old license-free records from changing metadata on a cache hit.
- Base metadata is loaded before bundling and reused across determinism iterations.
- Local dependency layouts under signature policy fail in preflight. Signing keys are excluded from snapshots, with required-asset overlap rejected.
- Documentation explicitly explains builder-dependent image identity, partial inventory scope and the absence of automatic base-inventory signature trust.

Evidence: [local signature and external-consumer results](validation/metadata.json), [private GAR checkpoint](validation/metadata-gar.json). GAR checked six private signatures and metadata for both Linux architectures. These are checkpoint results with recorded descriptors, not a claim that every registry or every alpha release artifact was tested.

The follow-up review led to explicit skipped-artifact diagnostics and regressions for foreign predicates/older SPDX documents. Signature verification now runs once per selected immutable dependency before bundling, not once per determinism iteration. Oversized or unsupported optional metadata is reported as skipped; integrity/subject failures remain fatal. Source-mode installations without the repository lock receive an actionable error.
