# rc.3 candidate validation

The tested distribution was prepared with Bun 1.3.11 from the reviewed rc.3 source tree. Its CLI SHA256 is `09486aa233147f781fb2068335d6b02fc4e5359853f2445573a5dfa5f2deb3cd`. The release was published from `f99257abe03493aff2d834f39bf8185b62aee1e9`. Anonymous setup verified the published assets, CLI version and exact byte equality with this candidate (7,793,861 CLI bytes).

The exact bundled CLI passed:

- Linux amd64 and arm64 compile execution with literal dynamic imports, nonroot identity, a read-only filesystem, full authenticated Bun revision comparison and repeated-build image identity.
- OTLP/HTTP JSON export of both traces and metrics to OpenTelemetry Collector 0.120.0.
- Generic application migrations, worker tasks, database writes, HTTP/native hashing/static file access and graceful shutdown on both architectures.
- Signed runtime injection and actual revision checks, static-base rejection, local OCI base input, warm runtime-layer cache reuse and the missing-native-library boundary on both architectures.

CI additionally executes compile mode with Bun 1.3.11, 1.3.12 and 1.3.13 on Linux amd64. Bun 1.3.12+ rewrites ELF sections during compilation; runtime provenance identifies the authenticated compiler input, not an unchanged executable prefix. The selected host compiler is trusted.

An initial local full-suite run timed out in the existing parallel-workspace performance test while other validation was active; its subsequent cleanup caused an ENOENT. An isolated rerun passed without changing the test timeout. Required final-source CI remains the merge gate.

These are generic fixtures, not certification of external application workloads. Historical registry interoperability evidence is not reassigned to this candidate. Private ECR remains unverified. Release provenance attestations and the build Action are subsequent work.
