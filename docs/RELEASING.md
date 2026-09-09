# Release distribution and setup Action

This source prepares version **0.1.0**. The [published alpha.2 validation](PUBLISHED_RELEASE_VALIDATION.md) records historical installation and registry evidence; it does not certify a later release. The artifact is a bundled JavaScript CLI run by Bun. It supports Linux/macOS runners and Bun >=1.3.11 <1.5, validated with 1.3.11, 1.3.12, 1.3.13, 1.4.0 and 1.4.2. Native standalone executables remain future work. npm distribution is implemented through a separate [verified packaging workflow](NPM_DISTRIBUTION.md).

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

Once the version tag and release exist:

```yaml
steps:
  - uses: actions/checkout@v7
  - uses: sakajunquality/bunko@v0.1.0
    with:
      version: v0.1.0
      bun-version: 1.4.2
      verify-attestation: 'true'
  - run: bunko version
```

For stronger pinning, select a reviewed Action commit SHA while keeping the desired release version explicit. Registry login is separate from installing bunko; configure Docker credentials before a build that publishes an image.

| Input | Default / purpose |
| --- | --- |
| version | v0.1.0 on main after verified promotion; an explicit version, never latest |
| bun-version | 1.4.2; installs the Bun runtime through the pinned setup-bun Action |
| repository | sakajunquality/bunko; repository hosting release assets |
| token | github.token; needs contents:read on the release repository for private assets |
| distribution-directory | Optional directory of already downloaded assets and SHA256SUMS; skips network download |

The Action adds `bunko` to PATH and exposes `version` and `bunko-path` outputs. The launcher uses the installed Bun executable directly and forwards arguments unchanged. Each installation uses an isolated runner temporary directory. There is no implicit update to a newer release.

A job's GITHUB_TOKEN ordinarily accesses its own repository. For a different private release repository, supply a token with read access and configure private Action sharing where applicable. [GitHub release asset API](https://docs.github.com/en/rest/releases/assets) documents authenticated octet-stream downloads. The installer follows HTTPS redirects and strips the GitHub token when leaving api.github.com.

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

At preparation time, setup defaults are rc.5 and Bun 1.4.2. The immutable v0.1.0 Action tag retains these preparation-time defaults; set both inputs explicitly when pinning it, as shown above. Projects requiring an older toolchain should set `bun-version` to their supported exact version. Future default promotions must follow publication and verification of the selected immutable release.
