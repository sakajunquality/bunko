# Local manifest development

`bunko resolve -f manifests --local --platform linux/arm64` builds every selected target, loads the images into Docker, and then emits manifests containing content-derived local tags. `--kind --kind-cluster NAME` loads every node in that existing kind cluster instead. These modes do not publish images to a registry. Base images and packages can still require downloads; a local base layout and available dependency cache eliminate those particular downloads.

```sh
bunko apply -f manifests --kind --kind-cluster development \
  --platform linux/arm64 --selector app=api
```

Kind apply explicitly uses `kind-development` as the Kubernetes context. A conflicting explicit context is rejected. Direct `apply --local` is rejected because a Docker image store alone does not identify a Kubernetes cluster; use resolve for Docker or kind for apply.

Use `imagePullPolicy: Never` or `IfNotPresent` for loaded development images. Bunko does not silently rewrite pull policies. The tags encode image content but are local tags, not registry digest references. Registry-only `--image-refs` remains unavailable in these modes.

All builds and manifest validation finish before any loading. A failed load can leave earlier targets loaded; partial reports record them, and stdout is withheld until all loads succeed. Local/kind loading requires one platform. Metadata/signing combinations retain their existing output restrictions.

`test/local-resolve-smoke.ts` validates a disposable kind Pod with registry requests forbidden during resolution after preparing a local base. It never selects a production context.

With `--local` or `--kind`, an unspecified platform defaults to the host architecture: `linux/arm64` on Apple Silicon or ARM64 Linux, and `linux/amd64` on x64 hosts. An explicit `--platform`, `BUNKO_DEFAULT_PLATFORMS`, or manifest `bunko.platforms` retains precedence. For a remote Docker daemon or a kind cluster whose nodes differ from the host, select the target architecture explicitly; this default does not inspect the daemon or cluster. Registry and tarball output retain the `linux/amd64` default.
