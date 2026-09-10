# v0.6.0

Builds and offline diagnostics share target configuration validation, including workspace dependency settings and canonical dependency-map paths. Deep workspace diagnostics use one snapshot of the selected targets. Source analysis shares a lazy per-file TypeScript syntax tree across visitors while retaining safe prefilters.

CLI cancellation aborts network work, stops queued work, signals owned subprocess groups and drains them before deleting registered temporary directories. SIGINT returns 130 and SIGTERM returns 143. A hard cancellation deadline retains scratch when work has not drained. Library calls do not install process signal handlers.

Kubernetes label selectors now filter the items of a List by each item's labels and omit empty Lists. Selected YAML items preserve required aliases with bounded materialization. Example containers use nonroot execution, disabled privilege escalation and dropped capabilities.

Registry authentication errors include provider-specific setup guidance for GHCR, Google Artifact Registry/GCR, ECR and Docker Hub, without changing credential precedence. The Snyk triage document distinguishes source-level reasoning from verified finding-specific ignores; no production source files or Code findings are suppressed.

Bun support remains >=1.3.13 <1.5, with CI coverage for 1.3.13, 1.4.0 and 1.4.2. Registry cache writes still require an explicit destination. See [release evidence](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.6.0.md) for validation scope and remaining limits.
