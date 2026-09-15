# Resume without duplicate publication

Inspect remote state first after interruption. A local process's missing output is not evidence that a remote mutation failed.

| Observed state | Next action |
| --- | --- |
| Existing immutable tag/release | Inspect its peeled commit, run and artifacts. Resume verification; never move or recreate it. |
| Version changed during tests | Discard that run. Finish edits and rerun required checks against fixed source. Cache records also embed the package version, so child processes can reject their parent's old metadata. |
| CLI hash differs across candidates | Stop promotion. Compare toolchain on PATH, dependency lockfile, source identity and bundling inputs. Do not update the expected hash merely to match. |
| Wrong-ref negative check fails | Confirm the reason is a source-ref mismatch. Network/authentication failures do not demonstrate correct provenance rejection. |
| GitHub asset download reset before npm publish | Confirm publish never ran. A bounded retry of failed preparation/dependent jobs on the same source is appropriate. |
| npm publish succeeded but version is 404/ETARGET | Treat as accepted/pending, not absent. Read the publish log without exposing signed URLs. Retry bounded read-only metadata checks; keep previous artifacts for rollback. |
| npm verify-published job exhausts propagation wait | Once visible, inspect job IDs and rerun **only verify-published** with `gh run rerun RUN --job JOB`. Confirm no publish job is repeated. Compare successful publishing candidate bytes and independently test consumers. |
| npm remains unavailable after a reasonable observation window | Record acceptance time, run, version, signature log and current read-only state. Check npm service status/current official guidance. Do not republish, unpublish, change dist-tags or claim availability. Explain the external blocker; continue independent authorized preparation without claiming completion. |
| Container dispatch succeeded | Locate the actual container run and follow it; do not infer publication or dispatch again. |
| CLI succeeded but npm/container failed | Preserve the verified CLI release and work only on the failing channel. Inspect whether that channel already published before retrying. |
| Workflow implementation needs a fix | Review/merge it and use a new main dispatch for npm/container. An old-run rerun uses old workflow code. Tag-bound workflow recovery needs explicit identity analysis; never move its tag. |
| CodeRabbit says bot review skipped or is rate limited | It is not approval. Request review when authorized, inspect findings if supplied, and document unavailability. Follow current repository review requirements; do not weaken protections or invent approval. |
| Another PR arrives after tagging | Triage separately. It cannot enter the immutable release; do not silently expand the release or create another version. |

Do not turn a single unexplained failure into a product fix. Reproduce with fixed inputs first. In v0.8.2, changing the version during a live suite caused both version assertion failures and a misleading cache-concurrency failure. In v0.8.3, npm accepted publication but registry visibility exceeded the initial five-minute verification window; only post-publication verification was retried.
