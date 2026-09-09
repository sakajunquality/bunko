# npm and bunx distribution

The npm package is [`@sakajunquality/bunko`](https://www.npmjs.com/package/@sakajunquality/bunko), first published as `0.1.0-rc.5` on 2026-09-09. The unscoped `bunko` package is unrelated to this distribution. See [initial publication evidence](validation/npm-rc5.md).

The repository root remains private to prevent publishing the development checkout. `scripts/npm-package.ts` creates a separate, allowlisted package from an existing GitHub release. Its `bunko.js`, licenses, checksums and release provenance are copied without modification. No lifecycle scripts or runtime npm dependencies are included. Bun must already be installed and on PATH; npm does not install it. Supported hosts are Linux and macOS, x64 and arm64, with Bun >=1.3.11 <1.5.

The current stable release is **0.1.0**, published through GitHub Actions trusted publishing with npm provenance. See [stable publication evidence](validation/v0.1.0.md).

Usage:

```sh
bunx @sakajunquality/bunko@0.1.0 version
bunx @sakajunquality/bunko@latest build .
npm install -g @sakajunquality/bunko@0.1.0
bunko version
```

Use explicit versions for reproducible use. Prereleases publish under `next`; stable releases use `latest`. Update or roll back by installing the selected previously published version explicitly. Existing npm versions must never be replaced or unpublished as a rollback mechanism.

## Prepare and inspect before publication

Run the **npm distribution** workflow on main with the existing release tag and `publish: false`. It verifies release provenance against the exact tag commit in main history, packages the unchanged CLI, checks the tarball file list, and tests local/global npm installation, npm exec, local bunx and arguments containing spaces. The `npm-candidate` artifact contains the tested tarball and its integrity report. No npm credentials are required to prepare it.

For local preparation, download the complete release into a new directory, verify it, then package it:

```sh
gh release download v0.1.0 --repo sakajunquality/bunko --dir dist/release
BUNKO_ATTESTATION_SOURCE_DIGEST=9ea6580b719049f4afa3fcc8cf3ae2f21b8cc722 \
  bun scripts/verify-release.ts dist/release v0.1.0
bun scripts/npm-package.ts dist/release dist/npm v0.1.0
bun scripts/validation/npm-smoke.ts dist/npm dist/npm-artifact
```

Packaging verifies checksums before executing the CLI version check. Checksums alone are not authentication: verify the release provenance first. `verify-release.ts` passes the enclosed `PROVENANCE.jsonl` directly to `gh attestation verify --bundle` for every release subject. The packaged GitHub provenance authenticates the enclosed release assets, while npm provenance authenticates the separately generated npm tarball and its packaging workflow.

## Account bootstrap and trusted publishing

An npm account controlling the `sakajunquality` scope is required. Complete login and any email/2FA prompts directly with npm; do not put passwords, one-time codes or access tokens in repository files or review comments.

For a new package, establish its ownership with an authenticated first publication of the reviewed tarball if npm requires that before exposing package settings. Use `--access public --tag next --ignore-scripts` for the initial RC. A local bootstrap publication does not have GitHub Actions npm provenance; record that distinction and verify the published tarball separately. Do not publish an empty placeholder version merely to reserve the name.

Then configure the npm package's **Trusted Publisher** for:

- GitHub owner: `sakajunquality`
- Repository: `bunko`
- Workflow filename: `npm.yml`
- GitHub environment: `npm`
- Direct publishing permission enabled

Create the matching GitHub `npm` environment and restrict deployment branches to main. The workflow also requires main for publishing. Use GitHub-hosted runners and a supported npm CLI (>=11.5.1) with Node >=22.14.0. It publishes with OIDC and provenance without a long-lived npm token. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

rc.5 was published during authenticated local bootstrap and has no npm workflow provenance. Its enclosed CLI release provenance remains intact. Version 0.1.0 is the first successful OIDC publication; both versions already exist and must not be published again.

For future releases, dispatch the workflow on main with a **new, unpublished npm version** whose GitHub release has already been published and verified, and `publish: true`. It publishes the tested tarball once, downloads it independently, compares its SHA512 integrity with the candidate and executes the npm and bunx consumers. A failed post-publication check must be investigated before declaring success; rerunning publication of an existing version is not a repair strategy.

The stable package passed anonymous tarball download, exact candidate integrity comparison, npm installation, fresh-cache bunx execution with both the exact version and `latest`, and `npm audit signatures` verification of the registry signature and npm attestation. Registry installations also passed rc.5 → 0.1.0 → rc.5 → 0.1.0 upgrades and rollback, followed by Bun installation and bunx execution. The `next` tag remains on rc.5; `latest` selects 0.1.0. See the [versioned results](validation/v0.1.0.md).
