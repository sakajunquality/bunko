# Prepared dependencies, apply, and cache management

These operations are explicit commands. Ordinary builds still do not execute install scripts, apply Kubernetes resources, or prune caches.

## Prepared dependency artifacts

Prepare Linux dependencies outside bunko when installation requires scripts or generated files. The producer is responsible for running that preparation in a controlled target-platform environment. bunko only packages the completed tree:

```sh
bunko pack-deps ./prepared-project --lockfile ./bun.lock \
  --platform linux/amd64 --oci-layout ./deps-amd64
bunko push-layout ./deps-amd64 --repo registry.example/team/dependencies
bunko build . --repo registry.example/team \
  --deps-artifact linux/amd64=registry.example/team/dependencies@sha256:DIGEST
```

For local use, the reference can be `linux/amd64=layout:./deps-amd64`. Repeat `--deps-artifact` once for each selected platform; the complete map is required. `pack-deps` accepts a project directory containing node_modules, and `--workdir` selects the image destination (default /app). It copies only node_modules, validates internal links and native ELF architecture, and emits a single-platform OCI artifact. Registry inputs must be digest-pinned.

Import verifies compressed blob digests, the uncompressed DiffID, normalized lock digest, platform, destination, media types, and metadata. It limits decompressed content to 2 GiB and tar entries to 200,000. The strict ustar/PAX reader rejects traversal, whiteouts, devices, hardlinks, overlapping/case-colliding paths, links outside node_modules, and dangling/cyclic links. It writes regular files before creating links, then independently rebuilds inventory and validates native architecture. Imported files are repacked using the current build timestamp. The producer artifact digest is recorded in provenance.

The initial contract supports standalone bundle targets with explicit runtime externals. Workspace projection, compile mode, arbitrary Docker images as dependency sources, and automatic artifact-signature trust policies are not supported. A digest pins bytes; it does not authenticate a producer. Verify the producer's signature separately with `bunko verify` when required. Ready-to-run package scripts may be present but are never executed by bunko. Build-time dependencies still use the project's frozen install.

`push-layout` publishes exactly one runnable root (with its subject artifacts), or one standalone artifact, to an exact repository. Repeat `--tag` for optional tags. It prints the immutable reference only after success.

## Apply

```sh
bunko apply -f manifests/ --context . --repo registry.example/team \
  --kube-context development --namespace example --server-side
```

All inputs are resolved before a bounded, read-only `kubectl get --raw=/version` preflight checks the selected cluster. Failure stops before publishing images or attachments. After a successful preflight, all required publications/attachments finish before `kubectl apply` starts. kubectl receives the complete document stream through stdin. Its stdout, stderr, and exit status are preserved. `--kubectl-path`, `--field-manager`, and `--kube-dry-run=client|server|none` are also supported. `--validate=strict|warn|ignore` (including kubectl’s `true`/`false` aliases) is forwarded to apply; see the [kubectl reference](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_apply/). Client dry-run and disabled schema validation do not promise cluster-free operation: the preflight still requires a reachable configured cluster. A Kubernetes dry-run still builds and publishes referenced images; it controls only kubectl. The build-level `--dry-run` remains incompatible with resolve/apply.

Kubernetes apply is not an atomic multi-resource transaction: a kubectl failure can leave some resources applied. Connectivity preflight does not guarantee later authorization, admission, or availability. No rollback is attempted. `--report` records the resolve/preflight/apply phase and exit status without copying manifest bodies or kubectl diagnostic output into reports. Validation uses a disposable kind cluster, never the user's current production context.

## Prune

```sh
# Preview local keys older than seven days (age is in seconds).
bunko prune --cache-dir ~/.cache/bunko/v1 --older-than 604800
# Explicitly execute the same selection policy.
bunko prune --cache-dir ~/.cache/bunko/v1 --older-than 604800 --execute
# Remote preview; use --execute only after inspecting the selected tags.
bunko prune --cache-repo registry.example/team/cache
```

Local pruning validates known cache records, selects by record modification time, and removes only blobs referenced by selected keys and no retained keys. Unknown namespaces, symlinked cache paths, malformed records, and non-regular blobs are refused. Unreferenced files of unknown origin are retained. Newer records are not last-use tracking; a frequently read but old entry can be selected.

Cache writers and local pruning use the same cooperating-process lock. Readers independently verify copied blobs and fall back to a miss if concurrent pruning removes one. New-format crashed guards are recovered only under the matching OS-backed mutex with a confirmed dead local owner. Legacy, incomplete, foreign-host and uncertain guards are retained: inspect `.bunko-lock/owner.json` and stop all cache users before manual recovery. Never remove or replace `.bunko-lock.sqlite` while the cache is in use. Older writers that use the directory guard remain serialized; versions predating that guard must not run concurrently with prune.

Remote pruning selects all strictly named `bunko-cache-v1-*` tags whose manifest/config match the cache contract. Tag listing is paginated and restricted to the selected repository. Remote age filtering is not inferred from image timestamps. Execution rechecks each tag and requests tag-only deletion. If unsupported, the command fails and recommends provider retention policies; it never falls back to deleting a manifest digest or blob. Provider garbage collection determines reclaimed storage. Remote deletion is not transactional; earlier tags may have been removed if a later request fails.

Use dedicated cache repositories and provider retention policies where tag-only deletion is unavailable. This feature does not modify retention policies or cloud IAM.

`bun run test:prune-smoke` exercises preview and tag-only deletion against a disposable Distribution registry and verifies the runnable image remains available.

When one target fails during parallel preparation, Bunko stops scheduling targets
and cancels cooperating work in that preparation group. Owned sibling subprocesses
receive SIGTERM, followed by SIGKILL after one second if needed. Bunko drains
in-flight tasks before removing their scratch and preserves the original target
error. This does not cancel unrelated library calls or publish partially prepared
targets. Operations that do not observe cancellation still have to finish before
cleanup; a single native filesystem copy remains cancellable between files only.
