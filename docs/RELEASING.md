# Alpha distribution and setup Action

The first distribution version is **0.1.0-alpha.1**. The artifact is a bundled JavaScript CLI run by Bun. It supports Linux/macOS runners and Bun >=1.3.11 <1.4, validated with 1.3.11. Native standalone executables and npm publication remain future work.

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

The **Release** workflow can be run manually on a branch to build and upload a candidate artifact without publishing a release. Pushing a `v*` tag triggers preparation and publication. Before publishing, the workflow requires the tag to equal `v` plus package.json's version and the tagged commit to be reachable from main. Prerelease versions create GitHub prereleases.

For the first release, merge the reviewed fixes, English documentation, Registry conformance, and release changes; update these notes and the Registry matrix with actual validation results. Then tag the reviewed main commit `v0.1.0-alpha.1`. No release is published merely by merging the PR. Creating the tag is the explicit release trigger.

Publication uploads the previously tested artifact, verifies SHA256SUMS again, and uses [RELEASE_NOTES.md](RELEASE_NOTES.md). It does not overwrite existing release assets. If publication is interrupted, inspect the release and its asset list before deciding how to recover it.

The repository is currently private, so release downloads and use of this Action from other repositories require appropriate repository access. bunko's own code is licensed under MIT; the release includes LICENSE and the bundled dependencies' complete notices. This workflow does not change visibility or publish to npm.

## Use the setup Action

Once the version tag and release exist:

```yaml
steps:
  - uses: actions/checkout@v7
  - uses: sakajunquality/bunko@v0.1.0-alpha.1
    with:
      version: v0.1.0-alpha.1
  - run: bunko version
```

For stronger pinning, select a reviewed Action commit SHA while keeping the desired release version explicit. Registry login is separate from installing bunko; configure Docker credentials before a build that publishes an image.

| Input | Default / purpose |
| --- | --- |
| version | v0.1.0-alpha.1; an explicit version, never latest |
| bun-version | 1.3.11; installs the Bun runtime through the pinned setup-bun Action |
| repository | sakajunquality/bunko; repository hosting release assets |
| token | github.token; needs contents:read on the release repository for private assets |
| distribution-directory | Optional directory of already downloaded assets and SHA256SUMS; skips network download |

The Action adds `bunko` to PATH and exposes `version` and `bunko-path` outputs. The launcher uses the installed Bun executable directly and forwards arguments unchanged. Each installation uses an isolated runner temporary directory. There is no implicit update to a newer release.

A job's GITHUB_TOKEN ordinarily accesses its own repository. For a different private release repository, supply a token with read access and configure private Action sharing where applicable. [GitHub release asset API](https://docs.github.com/en/rest/releases/assets) documents authenticated octet-stream downloads. The installer follows HTTPS redirects and strips the GitHub token when leaving api.github.com.

## Manual installation

Download all three assets from the same release into one directory, verify them, and run the CLI with Bun:

```sh
# Linux
sha256sum --check SHA256SUMS
# macOS
shasum -a 256 --check SHA256SUMS

bun ./bunko.js version
bun ./bunko.js build /path/to/app --repo ghcr.io/OWNER
```

The CLI file is portable between supported hosts. Use the supplied notices when redistributing it. Its bundled runtime has no external npm module requirement, but the applications being built still need their declared dependency installs and suitable Linux base images.
