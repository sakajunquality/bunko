# SQLite service

Build with `bunko build examples/sqlite --repo REGISTRY/PREFIX`, or add `--mode compile` for a Linux executable. The image runs as UID/GID 65532. Supply a writable `/tmp` (for example `docker run --read-only --tmpfs /tmp:rw,nosuid ...`) or set `DB_PATH` to a writable mounted persistent volume. `GET /health` checks readiness; `POST /visits` increments the counter and `GET /visits` reads it. This demonstration has no authentication and is intended for a local test environment.
