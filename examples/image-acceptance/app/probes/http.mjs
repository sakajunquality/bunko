import assert from "node:assert/strict";

const origin = process.env.TARGET_URL ?? "http://app:3000";
const kind = process.env.PROBE_KIND ?? "all";
assert.ok(["all", "catalog", "dependency"].includes(kind), "Unknown probe kind");
async function request(path) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(2000) });
  return { status: response.status, body: await response.json() };
}

let ready = false;
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    const health = await request("/health");
    if (health.status === 200 && health.body.ready === true) { ready = true; break; }
  } catch { /* Wait for the application, not just its container. */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(ready, "READINESS_FAILED");
console.log("READINESS_PASSED");

if (kind === "all" || kind === "catalog") {
  const result = await request("/catalog");
  assert.equal(result.status, 200, "CATALOG_HTTP_FAILED");
  assert.deepEqual(result.body.ids, ["known-entry"], "CATALOG_CONTENT_FAILED");
}
if (kind === "all" || kind === "dependency") {
  const result = await request("/dependency");
  assert.equal(result.status, 200, "DEPENDENCY_HTTP_FAILED");
  assert.equal(result.body.value, "driver-ready", "DEPENDENCY_CONTENT_FAILED");
}
console.log("APPLICATION_PROBE_PASSED");
