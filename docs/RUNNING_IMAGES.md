# Running images with restricted permissions

Bunko images execute the application directly. Image configuration cannot enforce runtime read-only mounts, resource limits, seccomp or lifecycle handling. Apply those in the container runtime or orchestrator and test the real workload.

```sh
docker run --init --read-only --user 65532:65532 \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
  --memory=512m --pids-limit=128 \
  -e TMPDIR=/tmp -e XDG_CACHE_HOME=/tmp -p 3000:3000 IMAGE
```

Use [the Kubernetes examples](../examples/manifests/services.yaml) for a numeric user/group, `RuntimeDefault` seccomp, read-only root, resource requests/limits, probes, a termination grace period and a bounded `/tmp` `emptyDir`. These sample limits need workload measurements. `fsGroup` makes the mounted scratch volume usable by the nonroot group. Memory-backed `emptyDir` counts toward container memory; disk-backed storage still needs node capacity planning. See [Kubernetes volumes](https://kubernetes.io/docs/concepts/storage/volumes/) and [security context](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/).

Only mounted storage is writable under a read-only root. `HOME`, `/app`, runtime dependency directories and packaged assets remain read-only. Configure package caches under `/tmp`, or mount an explicit persistent volume for durable state. Inherited base `Volumes` can create writable anonymous volumes in Docker/ECS even with `--read-only`; inspect the image configuration. Runtime user overrides do not rewrite OCI environment variables: verify `HOME` for your selected image and UID. Do not use `os.userInfo().username` as an authorization check; runtime/account-database behavior can differ.

## Shutdown and child processes

As PID 1, Bun/Node applications need explicit signal handling. Stop accepting requests on SIGTERM, finish bounded in-flight work, close databases and exit before the grace period. The Node HTTP and SQLite examples demonstrate this. The compile example is a finite command and exits on its own; a compiled long-running server needs the same signal handler as a source/bundle server.

Signal handlers do not reap arbitrary orphaned grandchildren. Docker `--init` supplies an init process that forwards signals and reaps children. Kubernetes has no equivalent per-container flag: applications that spawn process trees need a reviewed init in their chosen base and an explicitly configured deployment entrypoint, preserving Bunko's runtime argv, or a reviewed pod process-namespace design. Bunko does not download or inject an init binary. Test shutdown and orphan handling for that deployment rather than assuming the hello fixture certifies every application.

## Memory and diagnostics

Measure peak resident memory under the actual cgroup limit, including native allocations, compiled assets, buffers and scratch storage. Node's `--max-old-space-size` is not a total process-memory limit. Bun documents cgroup-aware heap sizing and `--smol` as a memory/performance tradeoff; do not assume a fixed heap or claim that cgroups are ignored. See [Bun runtime](https://bun.com/docs/runtime). Runtime profiling output needs writable directories, for example `--cpu-prof-dir=/tmp` or `--heap-prof-dir=/tmp`.

For a shell-less pod, use an authorized ephemeral debug container, for example `kubectl debug -it POD --image=YOUR_APPROVED_DEBUG_IMAGE --target=api`. Process namespace access depends on runtime support and cluster policy; it does not automatically mount the target container's filesystem. See [Kubernetes debugging](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/).

Set `TZ` and `LANG` explicitly when needed; availability of timezone/locale data depends on the base. `NODE_ENV=production` is the default and can be overridden with `bunko.env`. For named-entrypoint images, override Kubernetes `args`, preserving the generated `command`/OCI Entrypoint and runtime flags.

## Bunko acceptance commands

`check-base --run` and rebase smoke containers use nonroot UID 65532, a read-only root, no network, dropped capabilities, no-new-privileges, a 64-process limit, 512 MiB memory and a 64 MiB `/tmp` tmpfs with `nosuid,nodev`. Rebase commands have a 60-second deadline. These are finite offline acceptance tests; applications needing network, persistent storage or larger resources need a separate deployment-level test. Scratch contents are discarded after the command.
