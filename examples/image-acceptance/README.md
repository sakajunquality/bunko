# Completed-image acceptance with existing tools

This experiment uses container-structure-test and Docker Compose to check images produced by the bundled Bunko CLI. It demonstrates why asset existence, a successful package import, and a running server do not prove application behavior. There is no new `bunko validate` command or Bunko-specific assertion language.

## Run the experiment

Prerequisites: a supported stable Bun version, Python 3, and a running local Docker daemon with Compose v2 or later. The runner supports Unix-socket Docker contexts, including Docker Desktop. It passes the selected socket to container-structure-test, which does not select Docker CLI contexts itself.

From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun scripts/validation/install-structure-test.ts ./dist/container-structure-test
BUNKO_STRUCTURE_TEST_PATH="$PWD/dist/container-structure-test" \
  BUNKO_SMOKE_PLATFORMS=linux/amd64 \
  BUNKO_SMOKE_REPORT="$PWD/dist/image-acceptance.json" \
  bun run test:image-acceptance
```

Use `linux/arm64` on an arm64 host. Omitting `BUNKO_SMOKE_PLATFORMS` runs both architectures and requires emulation for the non-native architecture. CI declares separate native amd64 and arm64 jobs. The installer downloads upstream v1.22.1 with a pinned SHA256 and refuses to overwrite its destination; reuse the installed file on subsequent runs.

The runner copies the fixture into temporary directories, builds two bundle-mode images and one source-mode image per platform, and executes four scenarios. It uses a digest-pinned Bun base. Source mode uses the required production dependency strategy; the bundle controls use the closure strategy. The workspace packages are authored here and require no npm downloads. Docker loads, isolated Compose networks, containers, and generated image tags belong to this experiment and are removed afterward. Summary reports remain only when explicitly requested. A forced termination such as SIGKILL can interrupt cleanup.

| Mode | Scenario | Structure, import, worker | Server readiness | Application expectation |
| --- | --- | --- | --- | --- |
| Bundle | Working image | Pass | Pass | Catalog contains `known-entry`; dependency returns `driver-ready` |
| Bundle | Same image with module-relative catalog lookup | Pass | Pass | Fails: catalog returns HTTP 200 with an empty list |
| Source | Module-relative catalog lookup | Pass | Pass | Catalog contains `known-entry`; dependency returns `driver-ready` |
| Bundle | Image missing a dependency declaration | Pass | Pass | Fails: invoking the lazy operation returns HTTP 500 |

The experiment succeeds only if both positive controls pass and both negative controls fail with their specific assertion markers. A Docker failure, startup timeout, or arbitrary nonzero exit does not count as an expected failure. All six structure tests must run for each image. The report includes the build mode for each scenario. The summary records the source OCI manifest/config digests and the Docker runtime image ID separately: containerd-backed Docker stores can expose a different ID after archive conversion. The runner saves the loaded image and independently hashes its config bytes to compare them with the build report before executing it.

## Why the controls fail

`app/src/lib/catalog.ts` normally reads from `BUNKO_DATA_PATH`. Setting `CATALOG_LOCATION=module` switches to the source module's relative directory. Bundling changes that module's runtime location, but the files remain at `/app/bunkodata/catalog`. The intentionally permissive fallback returns an empty list. The source-mode positive control uses exactly the same module-relative lookup and HTTP probe. It retains the workspace layout, so the catalog resolves to `/app/app/bunkodata/catalog`; the probe must receive `known-entry`, and the lazy dependency must return `driver-ready`. Its structure configuration checks that preserved asset layout, the `.ts` worker, and the source entrypoint including `--no-install`. This control does not exercise `BUNKO_DATA_PATH`.

The build can warn about this location expression; the example does not claim that static diagnostics are absent.

`@acceptance/lazy` imports its driver only when `run()` is called. The negative variant removes its driver dependency declaration from a temporary manifest and regenerates the lock. A root development dependency makes the call work in a hoisted checkout; the runner checks that first. Bunko's production closure omits the undeclared driver. Importing the lazy package and starting the server still succeed. The fixture uses the advisory undeclared-import policy so it can reach runtime validation; strict build policy may reject it earlier. This is a controlled workspace reproduction, not certification of arbitrary npm dependencies.

## Reuse the checks in an application

`structure.yaml` and `structure-source.yaml` are ordinary container-structure-test configurations for the bundle and source layouts, respectively. They check files, permissions, bytes, image metadata, a package import, and a worker command. Either can be adapted to any completed image:

```sh
container-structure-test test \
  --image "$APPLICATION_IMAGE" \
  --platform linux/amd64 \
  --config structure.yaml
```

Select the same Docker endpoint for both tools. For a local Unix-socket context, export `DOCKER_HOST` from `docker context inspect --format '{{.Endpoints.docker.Host}}'` before invoking container-structure-test if it otherwise selects the wrong socket.

`compose.yaml` starts the image with its default entrypoint and command, then runs `app/probes/http.mjs` in a second container. The probe waits for readiness and checks actual response values. Run an adapted configuration with:

```sh
ACCEPTANCE_IMAGE="$APPLICATION_IMAGE" ACCEPTANCE_PLATFORM=linux/amd64 \
  docker compose -p application-acceptance -f compose.yaml \
  up --no-build --exit-code-from probe --abort-on-container-exit
```

For this workspace fixture in source mode, also set `ACCEPTANCE_PROBE_PATH=/app/app/probes/http.mjs` and `CATALOG_LOCATION=module`.

Always follow that command with `docker compose ... down --volumes --remove-orphans`, including on failure. Use an isolated project name. The fixture runner handles both operations and their time limits.

For this Bun-containing fixture, the probe script is a declared asset and the client uses the same image. An application may instead use its own test-client image; compile/distroless images do not need a test runtime added to them. Database and service setup belong in the application's Compose configuration. Package import checks must use the relevant runtime resolution context, and behavioral probes must invoke the operations that load dependencies lazily.

## Findings and remaining Bunko-specific work

- Existing tools cover structural assertions, finite command tests, service startup, HTTP assertions through ordinary test code, and CI exit status. container-structure-test supplies JSON/JUnit output; Compose supplies service orchestration.
- A structural command test overrides the image entrypoint. It does not verify Bunko's named-entry selection contract. This runner checks the build report's entry map explicitly, while Compose exercises the default server command.
- Remaining integration work includes identifying the exact completed image across archive formats, resolving named entries, enumerating required platforms/entries, handing these to existing probes, and collecting failures and unexecuted checks without treating them as success.
- The next decision is whether these integrations justify a small `bunko validate` adapter. A general HTTP assertion language, dependency-wide automatic imports, and database orchestration are not required by this experiment.

The fixture covers bundle mode, a source-mode module-relative positive control, and one selected workspace target. Compile mode, source-mode missing-dependency behavior, external services, and arbitrary consumer suites are outside this experiment's acceptance claims.

## Local validation on 2026-09-14

With Bun 1.3.13, container-structure-test 1.22.1, Docker Engine 28.4.0, and Compose 5.5.0 on an arm64 Mac, all four Linux arm64 scenarios completed: the bundle working control and source module-relative control passed, and both bundle negative controls produced their required failures. All six structure checks passed for each of the three images. The report recorded successful cleanup of owned Compose resources and image tags.

The Linux amd64 images passed structure tests locally, but the emulated server did not reach HTTP readiness before the runner's timeout. The experiment reported failure and completed cleanup. The cause of that startup failure has not been established; this is not an amd64 behavioral pass. Native amd64 and arm64 CI jobs are configured, but were not executed as part of this local validation.

The separate cross-device smoke passed inside Linux arm64 with Bun 1.4.2: cold builds fetched donor bytes, warm builds fetched none, and final image digests matched. Selecting the work filesystem as the cache mount failed at the device-ID assertion. The 46 asset regressions and 69 location/dependency/entrypoint regressions passed, as did TypeScript checking and actionlint workflow validation.

References: [ko static assets](https://ko.build/features/static-assets/), [Docker test before push](https://docs.docker.com/build/ci/github-actions/test-before-push/), [Bake testing](https://docs.docker.com/guides/bake/), [Compose readiness](https://docs.docker.com/compose/how-tos/startup-order/), and [container-structure-test](https://github.com/GoogleContainerTools/container-structure-test). The latter is in maintenance mode; this experiment pins a release rather than adding it as a Bunko runtime dependency.
