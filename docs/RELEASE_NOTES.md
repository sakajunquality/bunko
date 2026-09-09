# v0.1.2

Bunko 0.1.2 reduces false undeclared-import diagnostics caused by tests and benchmarks shipped inside dependency packages.

- Closure dependency scans start at package entry points and follow literal relative imports. Unreachable shipped tests and unused sources no longer produce warnings or strict-policy failures.
- All declared entry targets and export patterns are considered, including multiple patterns and repeated substitutions in a target. Packages with no resolvable entry retain a conservative fallback scan excluding common test locations.
- Nested package manifests obey the scan size limit, and the reachability queue processes each JavaScript file once without repeatedly shifting the queue.

The `warn`, `error` and `off` policies retain their meanings. This is advisory syntax analysis: computed imports, unsupported file types and oversized/unparseable files are not proof of runtime compatibility. Optional literal imports inside try/catch may still be reported. See [configuration](https://github.com/sakajunquality/bunko/blob/v0.1.2/docs/CONFIGURATION.md) and [compatibility](https://github.com/sakajunquality/bunko/blob/v0.1.2/docs/APPLICATION_COMPATIBILITY.md).

Distribution evidence is recorded in the [0.1.2 validation record](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.1.2.md). GitHub CLI, GHCR and npm are verified separately before defaults are promoted. The immutable v0.1.2 Action tag retains its preparation-time CLI 0.1.1 default; select the desired CLI version explicitly. Bun >=1.3.11 <1.5 remains supported; npm does not install Bun.

External application-machine acceptance and private ECR remain unverified. musl and rebase remain tracked separately; setup Action separation and Marketplace publication remain paused.
