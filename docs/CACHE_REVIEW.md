# Cache distribution and retention review

Claude reviewed the implementation and a follow-up checked the resulting fixes. The cache boundary is explicit: readers must trust cache writers; content-addressed integrity alone does not prove which inputs produced a layer. The CI producer policy does not authenticate application cache contents.

Review changes include local persistence of accepted registry hits after build/determinism checks, repair of dangling local records, a common 8 MiB metadata bound, preserved hit origins, normalized reader deduplication, early environment-repository validation and a bytewise retention tie-break. Locked usage/preview operations deliberately require a writable cache for a consistent snapshot.

Regression tests cover denied/corrupt source fallback, promotion to a distinct destination, real build wiring with remote writes disabled, subsequent local-only reuse, shared-blob accounting, oversized-record refusal and CLI budget validation. [Distribution validation](validation/cache-distribution.json) verifies ordered read fallback, cross-repository hit promotion, fresh-client reuse and matching preview/deletion accounting against a disposable real registry. It does not establish remote capacity management or provider-specific retention policies.
