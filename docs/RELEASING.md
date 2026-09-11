# Release distribution and setup Action

The current published release is **0.7.0**. The dedicated [Marketplace setup Action](https://github.com/marketplace/actions/setup-bunko) is versioned independently: setup-bunko v0.1.0 installs CLI v0.6.2 by default. The [published alpha.2 validation](PUBLISHED_RELEASE_VALIDATION.md) records historical installation and registry evidence; it does not certify a later release. The artifact is a bundled JavaScript CLI run by Bun. The published 0.7.0 CLI supports Linux/macOS runners and Bun >=1.3.13 <1.5, validated with 1.3.13, 1.4.0 and 1.4.2. Version 0.1.4 remains available for Bun 1.3.11/1.3.12. Native standalone executables remain future work. npm distribution is implemented through a separate [verified packaging workflow](NPM_DISTRIBUTION.md).

For maintainers, follow the [release checklist](RELEASE_CHECKLIST.md) for commit/tag guards, publication order, consumer verification and failure recovery.

## Prepare and inspect artifacts

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run release:prepare
```

This creates a new `dist/release` directory containing `bunko.js`, `SHA256SUMS`, `LICENSE`, and `THIRD_PARTY_NOTICES.md`. Existing destinations are refused. To prepare again, select another directory with `bun run release:prepare /tmp/bunko-release-candidate`.

The CLI version comes from package.json, so artifact and source versions cannot drift. Preparation verifies checksums and runs the bundled version command. The bundled parsers retain their licenses. Checksums detect damaged or mismatched assets; they are not signatures or provenance attestations.

CI exercises the local Action on Linux and macOS using these exact prepared files. Tests also cover authenticated GitHub asset downloads, redirect credential isolation, checksum failure before execution, version mismatches, and paths containing spaces/quotes.

## Release workflow

The **Release** workflow can be run manually on main to build and upload a candidate artifact without publishing a release. Pushing a `v*` tag triggers preparation and publication. Before publishing, the workflow requires the tag to equal `v` plus package.json's version and the tagged commit to be reachable from main. Prerelease versions create GitHub prereleases.

For a new version, merge reviewed changes and verify the recorded CI/runtime results before creating its matching version tag on the reviewed main commit. Existing version tags and assets must not be replaced. A manually dispatched candidate build prepares downloadable artifacts without creating the version tag or release. No release is published merely by merging the PR. Creating the tag is the explicit release trigger. To additionally test network installation of an existing release during a manual dispatch, set the optional `published-version` input (for example, `v0.1.0-alpha.2`). This check uses the exact executable path returned by the setup action.

A separate consumer job verifies the signed provenance bundle against the exact workflow, source ref and commit before publication. Publication adds `PROVENANCE.jsonl` and uploads the previously tested artifact, verifies SHA256SUMS again, and uses [RELEASE_NOTES.md](RELEASE_NOTES.md). It does not overwrite existing release assets. If publication is interrupted, inspect the release and its asset list before deciding how to recover it.

Public release assets can be downloaded without repository credentials, subject to GitHub rate limits. Private forks and private release repositories require appropriate repository access. bunko's own code is licensed under MIT; the release includes LICENSE and the bundled dependencies' complete notices. This workflow does not change visibility or publish to npm.

## Use the setup Action

Use the dedicated [setup-bunko Action](https://github.com/marketplace/actions/setup-bunko). Pin the Action to the reviewed v0.1.0 source commit; its default CLI is v0.6.2, independent of the Action's own release number:

```yaml
permissions:
  contents: read
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
    with:
      persist-credentials: false
  - uses: sakajunquality/setup-bunko@df07f107af7d41b8476a875b966ee70039fb29ab # v0.1.0
    with:
      version: v0.7.0
      bun-version: 1.4.2
  - run: bunko version
```

`version` may be omitted to use the CLI default recorded in that setup-bunko release. The wrapper forwards an explicit CLI version to the installer pinned in the bunko repository; its own v0.1.0 tag never selects CLI v0.1.0. Updating the CLI release does not change an existing wrapper release's default. Maintainers update the wrapper's implementation pin, CLI default, documentation and consumer tests together, then publish a separate Action release.

| Input | Default / purpose |
| --- | --- |
| `version` | `v0.6.2`; full published CLI release version, never an implicit latest lookup |
| `bun-version` | `1.4.2`; installs Bun through the pinned setup-bun Action |
| `repository` | `sakajunquality/bunko`; trusted GitHub.com repository hosting release assets |
| `token` | `${{ github.token }}`; read access to release assets and attestations |
| `verify-attestation` | `true`; verify signed provenance and release-tag identity before executing the CLI; requires `gh` |
| `source-commit` | Optional full source commit digest to constrain provenance verification; requires `verify-attestation: 'true'` |
| `distribution-directory` | Optional local directory containing `bunko.js`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `SHA256SUMS`, and `PROVENANCE.jsonl` when verification is enabled |

Linux and macOS are supported; Windows is not. Self-hosted runners need Bash, the prerequisites of [setup-bun](https://github.com/oven-sh/setup-bun), and a current GitHub CLI supporting `gh attestation verify`. Release sources on GitHub Enterprise Server are not supported. A local distribution skips payload downloads; provenance verification may still require network access. For unsigned historical releases, explicitly set `verify-attestation: 'false'`; checksum verification remains mandatory. See [release provenance](RELEASE_PROVENANCE.md).

The Action adds `bunko` to PATH and exposes `version` (without the `v` prefix) and `bunko-path` outputs. Each installation uses an isolated runner temporary directory, with no persistent CLI cache. Registry authentication is separate; see [building in CI](CI.md). Published-tag installation passed on Linux and macOS in [the setup-bunko consumer run](https://github.com/sakajunquality/setup-bunko/actions/runs/34565006204).

A job's GITHUB_TOKEN ordinarily accesses its own repository. For a different private release repository, supply a token with read access. The installer follows HTTPS redirects and strips the token when leaving api.github.com.

## Existing setup entry point

`sakajunquality/bunko@...` remains supported. It exposes the same inputs and outputs, but defaults `version` to empty and `verify-attestation` to `false` for compatibility. Its installer implementation remains in this repository; the dedicated Marketplace Action reuses it. The following resolution rules apply only to this existing entry point, not the dedicated wrapper's default:

The `version` input is optional starting with v0.1.3. Earlier immutable tags retain their original defaults; v0.1.2 still installs CLI 0.1.1 unless `version` is explicit. Current Actions resolve their version in this order:

1. The `version` input, when it is not empty. An explicit version always wins, and it is the only way to install a release other than the Action's own.
2. `GITHUB_ACTION_REF`, when the ref is version-shaped, such as `v0.7.0`, and `GITHUB_ACTION_REPOSITORY` still names the release repository. Only the spelling of the ref decides this; the runner reports the requested ref without saying whether it is a tag, so a branch named `v9.9.9` selects release v9.9.9 and fails when no such release exists. Refs that are not version-shaped, including `main`, an alias such as `latest` and a commit SHA, and refs reported for a wrapping Action, fall through to the next step.
3. `package.json` in the Action checkout the ref resolved to, prefixed with `v`. That file is tagged together with the release, so a branch or commit-SHA pin installs the release recorded in the commit it pins.
4. A literal in `scripts/setup.ts`, reached only outside GitHub Actions, where neither the ref nor an Action checkout exists.

The installation log records the selected version and its source, for example `Selected bunko v0.7.0 from GITHUB_ACTION_REF`. For stronger pinning, select a reviewed Action commit SHA; a commit that includes this resolution installs the release its checkout declares, so `version` stays optional there too. Registry login is separate from installing bunko; configure Docker credentials before a build that publishes an image.

Action tags cut before this resolution existed retain their preparation-time CLI default, which is the previous release; the immutable v0.1.2 tag defaults to CLI 0.1.1 unless `version` is passed. Starting with v0.1.3 the tag installs its own CLI version and `version` is optional. `bun-version` remains a literal default, so projects requiring an older toolchain should still set it to their supported exact version. For this existing entry point, releasing does not require a follow-up CLI-default bump: the tag and tagged `package.json` carry it. The dedicated setup-bunko repository has its own explicit default and release process.

## Manual installation

Download the CLI, checksums, license, third-party notices and provenance bundle from the same release into one directory, verify them, and run the CLI with Bun:

```sh
# Linux
sha256sum --check SHA256SUMS
# macOS
shasum -a 256 --check SHA256SUMS

bun ./bunko.js version
bun ./bunko.js build /path/to/app --repo ghcr.io/OWNER
```

The CLI file is portable between supported hosts. Use the supplied notices when redistributing it. Its bundled runtime has no external npm module requirement, but the applications being built still need their declared dependency installs and suitable Linux base images.

Historical pre-release review and validation are recorded in [RELEASE_REVIEW.md](RELEASE_REVIEW.md) and [the alpha.2 validation summary](validation/alpha2-release.json).
