# Preparing generated or native dependencies

Use BuildKit when a dependency needs generation or native compilation. Bunko's normal build never executes install scripts. This Dockerfile is a template for a separate preparation context containing your package.json, frozen bun.lock and a reviewed generate.ts. Add the required compiler packages to the prepare stage if necessary; the compiler is not copied into the output.

```sh
docker buildx build --platform linux/arm64 \
  --build-arg BASE=oven/bun@sha256:REPLACE_WITH_VERIFIED_DIGEST \
  --secret id=npmrc,src=/secure/npmrc \
  --output type=local,dest=./prepared-arm64 ./dependency-context

bunko pack-deps ./prepared-arm64 --lockfile ./bun.lock \
  --platform linux/arm64 --oci-layout ./deps-arm64
bunko build . --platform linux/arm64 \
  --deps-artifact linux/arm64=layout:./deps-arm64 --repo REGISTRY/TEAM
```

Omit the secret option for public packages. Keep credentials and preparation outputs outside the application source. Repeat independently for amd64. Select an explicit compatible runtime base for native dependencies; an architecture check does not establish full ABI compatibility.

For a workspace member, export a self-contained node_modules tree containing every runtime external and its transitive files, including any required workspace package contents. Links must remain inside that tree. `pack-deps --artifact-target services/api` binds the artifact to that member and the root lock. Bunko verifies the target, platform, destination, lock, archive paths and native architecture on import. It does not flatten arbitrary producer workspace symlinks or authenticate the producer merely because the bytes match a digest.

Use `--deps-map FILE` with build, resolve or apply to select independent artifacts per target. Target and layout paths are relative to the map file:

```json
{
  "./services/api": {
    "linux/amd64": "layout:./deps-api-amd64",
    "linux/arm64": "REGISTRY/TEAM/deps-api@sha256:DIGEST"
  }
}
```

Unselected targets, duplicate canonical paths and incomplete platform mappings fail. Omitted targets use normal dependency preparation. Artifact mode requires bundle mode, explicit externals and no sharedDeps. A standalone artifact cannot be substituted for a target-bound workspace artifact.
