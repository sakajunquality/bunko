# Released format fixtures

These fixtures execute the original writer functions from the immutable commits
and Git blob identities recorded in `writers.json`. They cover every released
minor since the rebase capsule (0.8) and SBOM evidence (0.9) were introduced.

The input is a small synthetic image/configuration. Descriptor placeholders are
not a runnable OCI image or an attestation, and these fixtures do not claim
container execution, complete old-CLI compatibility, or shared-cache rollback.
They preserve the original serialized ownership capsules and evidence verbatim.
Both Bun and Node variants are included where the released writer supported them.

`evidence-readers.json` runs each recorded evidence reader against each emitted
fixture. In particular, the 0.9/0.10 readers reject degraded v2 evidence emitted by
0.11, while the current reader continues to accept v1. Omitted packages remain
unknown; they are never turned into a package-absence claim.

Regenerate deliberately from the repository root:

```sh
bun scripts/validation/format-fixtures.ts --write
```

Verify reproducibility without modifying fixtures:

```sh
bun run test:format-fixtures
```

The generator requires the recorded Git objects locally and executes those
historical source modules in temporary directories. It does not install packages,
contact registries, or use project credentials. Ordinary unit tests consume the
checked-in fixtures without Git history or network access.
