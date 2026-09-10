# v0.1.3

Bunko 0.1.3 adds image and verified URL asset sources, improves dependency closure performance and diagnostics, and makes the setup Action follow its own release ref.

- Asset mappings can copy files and directories from OCI images or fetch HTTPS files pinned by SHA256. Image selection follows the target platform unless explicitly overridden. Sources are cached and recorded in provenance; URL cache hits work offline, while image sources require registry resolution.
- Asset capture completes partial writes, bounds image inspection including implied directories, and rejects unsafe paths and unsupported links. Local and URL inputs are captured once across platforms. Changed image tags invalidate the assets layer without invalidating the application layer.
- Dependency reports show package sizes and inclusion reasons. Unchanged dependency closures reuse the cached plan without repeating installation and projection. Self-guarded optional package imports no longer produce undeclared-import failures under `warn`, `error` and `off`; `strict` still reports them.
- Terminal `check-config` and `doctor` output is easier to read and distinguishes locally inspected inputs from remote sources whose contents remain unchecked offline.
- Incidental `.DS_Store` files are omitted from asset directories, including mapped image directories. Asset mappings that explicitly select a `.DS_Store` path are rejected.
- The setup Action derives its CLI version from its own version-shaped ref or checked-out package metadata. Starting with `sakajunquality/bunko@v0.1.3`, a separate `version` input is optional; earlier immutable Action tags retain their original defaults.

See [configuration](https://github.com/sakajunquality/bunko/blob/v0.1.3/docs/CONFIGURATION.md), [compatibility](https://github.com/sakajunquality/bunko/blob/v0.1.3/docs/APPLICATION_COMPATIBILITY.md), and the [0.1.3 validation record](https://github.com/sakajunquality/bunko/blob/main/docs/validation/v0.1.3.md). Image and URL asset mappings copy content without introducing Dockerfile `RUN` steps. URL sources follow the documented redirect policy and should be treated as trusted configuration.

Undeclared-import diagnostics remain advisory syntax analysis: computed imports, unsupported file types and oversized or unparseable files are not proof of runtime compatibility.

Bun >=1.3.11 <1.5 remains supported; npm does not install Bun. GitHub CLI, GHCR and npm are verified separately before examples and container pins are promoted. External application-machine acceptance and private ECR remain unverified. musl and rebase remain tracked separately; setup Action separation and Marketplace publication remain paused.
