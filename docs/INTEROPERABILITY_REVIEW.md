# Local and OCI interoperability review

Claude Code reviewed local resolution/apply, prepared dependency mappings, TLS and zstd handling. Findings led to canonical real-path exclusion of TLS material, explicit Docker export decompression caps, decoder window limits, prepublication rejection of unsupported integrated-signing/TLS combinations, and normalized target-bound artifact paths. Follow-up regression tests cover directory aliases, key changes without source identity changes, required client certificates, redirects, duplicate canonical dependency targets and workspace artifact selection.

Actual validation completed:

- A disposable kind Pod started after local resolution with all Registry requests forbidden during resolution, using a prepared local base. [Result](validation/local-resolve.json).
- BuildKit v0.33.0 compiled a generated Node-API addon and generated data for amd64 and arm64. Packed/imported images returned the expected result under read-only, network-disabled runtime conditions. [Results](validation/prepared-dependencies.json).
- Both architectures ran images composed from zstd base layers and exported through verified Docker archives. [Results](validation/zstd-runtime.json).
- A real local TLS server enforced server trust and client authentication. Unit tests also check certificate isolation across redirected origins and zstd corruption/size limits.

A focused Claude follow-up found no blocking regressions. Two minor findings (relative certificate paths through config-file links and a root-like artifact target) were also corrected. The expanded complete suite passed 223 tests before the final small normalization regressions.

All validation resources were disposable and removed. No existing cluster, registry image, IAM setting or repository visibility was changed. These tests do not establish Docker Hub/ECR account-specific conformance, arbitrary native ABI compatibility, registry-mirror support or cosign compatibility with Bunko's TLS JSON configuration.
