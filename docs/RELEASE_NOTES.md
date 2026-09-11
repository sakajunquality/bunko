# v0.6.1

The CLI now warns before sending registry credentials over explicitly allowed HTTP connections, including credentials sent to a registry-selected token service. Warnings contain only the destination origin and appear once per origin per CLI invocation, including multi-project resolve/apply operations. Anonymous HTTP requests and HTTPS credential exchanges do not produce this warning. Registry authentication and the insecure-origin allowlist are unchanged.

Registry documentation clarifies that a Bearer challenge selects the token service that receives that registry's credentials. Treat the registry and its token service as trusted credential recipients.

Bun support remains >=1.3.13 <1.5, with CI coverage for 1.3.13, 1.4.0 and 1.4.2. See [release evidence](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.6.1.md) for validation scope and publication results.
