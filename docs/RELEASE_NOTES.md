# v0.3.1

Source-mode builds now package explicitly declared gitignored assets, such as frontend `dist/` output, without a separate copy or asset context. Exact paths, globs, and selected directory contents override `.gitignore`; ignored siblings stay excluded. `.bunkoignore`, asset exclusions, credential/output/cache exclusions, symlink rejection, and private-key checks remain authoritative. Missing assets still fail. This intentionally changes selection for projects that already declare ignored assets; review those selections before upgrading.

`runtime.systemCaTrust: true`, together with `runtime.caCertificates`, sets `SSL_CERT_FILE` to the packaged CA bundle for native clients that honor it. The setting applies image-wide and can replace public-root trust; supply all roots affected clients need. It replaces an inherited base value, rejects a conflicting application value, and leaves `SSL_CERT_DIR` and the base filesystem unchanged. Default Bun/Node extra-CA behavior remains unchanged.

Offline diagnostics explain both policies. The development guide now documents commands, prerequisites, pipeline ownership, and distribution surfaces. Bun support remains >=1.3.13 <1.5.

See [source mode](https://github.com/sakajunquality/bunko/blob/main/docs/SOURCE_MODE.md), [CA configuration](https://github.com/sakajunquality/bunko/blob/main/docs/CONFIGURATION.md#application-ca-certificates), and [release evidence](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.3.1.md).
