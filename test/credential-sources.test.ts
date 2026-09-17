import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authSources, registryCredentials } from "../packages/oci/credential-sources.ts";
import { RegistryClient } from "../packages/oci/registry.ts";
import { authCheck } from "../packages/bunko/auth-check.ts";
import { cosignCommand } from "../packages/bunko/cosign.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "bunko-auth-test-")); roots.push(path); return path; }
test("sources default to Docker and explicit selection replaces rather than appends environment", async () => {
  expect(authSources(undefined, undefined)).toEqual(["docker"]);
  expect(authSources(["github,docker", "github"], "docker")).toEqual(["github", "docker"]);
  expect(() => authSources([""])).toThrow("Auth sources");
  const env = { BUNKO_DOCKER_CONFIG: join(await directory(), "absent"), GITHUB_TOKEN: "SECRET" };
  expect(await registryCredentials(undefined, { env })("ghcr.io")).toBeUndefined();
  expect(await registryCredentials(["github"], { env })("ghcr.io:443")).toMatchObject({ password: "SECRET", source: "github" });
  for (const host of ["evilghcr.io", "ghcr.io.attacker.test", "ghcr.io:8443", "registry.test"]) expect(await registryCredentials(["github"], { env })(host)).toBeUndefined();
});
test("a selected helper with no credentials prevents fallback to another identity", async () => {
  const file = join(await directory(), "config.json"); await writeFile(file, JSON.stringify({ credHelpers: { "ghcr.io": "test" } }));
  const options = { env: { BUNKO_DOCKER_CONFIG: file, GITHUB_TOKEN: "SECRET" }, helper: async () => undefined };
  expect(await registryCredentials(["docker", "github"], options)("ghcr.io")).toBeUndefined();
  expect(await registryCredentials(undefined, options)("ghcr.io")).toBeUndefined();
  await writeFile(file, "{}"); expect(await registryCredentials(["docker", "github"], options)("ghcr.io")).toMatchObject({ source: "github" });
});
test("GitHub precedence is explicit and concurrent refreshes share one provider lookup", async () => {
  const file = join(await directory(), "config.json"); await writeFile(file, JSON.stringify({ credsStore: "test" }));
  let calls = 0;
  const provider = registryCredentials(["docker"], { env: { BUNKO_DOCKER_CONFIG: file }, helper: async () => { calls++; await Bun.sleep(5); return { username: "u", password: "secret" }; } });
  await Promise.all(Array.from({ length: 20 }, () => provider("ghcr.io", true))); expect(calls).toBe(1);
  const env = { GITHUB_TOKEN: "preferred", GH_TOKEN: "other" };
  expect((await registryCredentials(["github"], { env })("ghcr.io"))?.password).toBe("preferred");
  await expect(registryCredentials(["github"], { env: { ...env, GITHUB_TOKEN: "" } })("ghcr.io")).rejects.toThrow("Invalid github");
});
test("authentication probe distinguishes unchallenged access and never asserts repository permissions", async () => {
  const credentials = registryCredentials(["github"], { env: { GITHUB_TOKEN: "SECRET" } });
  const result = await authCheck("ghcr.io", "repository:org/app:pull,push", { credentials, fetcher: async () => new Response("{}") });
  expect(result).toMatchObject({ status: "success", authentication: "not-challenged", repositoryPermissions: "unverified" });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  let leaked = false;
  const rejected = await authCheck("ghcr.io", undefined, { credentials, fetcher: async (url) => {
    if (new URL(url).hostname !== "ghcr.io") leaked = true;
    return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://evil.test/token"' } });
  } });
  expect(rejected.status).toBe("failed"); expect(leaked).toBe(false); expect(rejected.realmAllowed).toBe(false);
});
test("an expired credential cannot become a cached Basic authorization", async () => {
  let requests = 0;
  const client = new RegistryClient("ghcr.io", { credentials: async () => ({ username: "u", password: "SECRET", expires: Date.now() - 1 }), fetcher: async () => { requests++; return new Response("", { status: 401, headers: { "www-authenticate": 'Basic realm="registry"' } }); } });
  await expect(client.request("/v2/")).rejects.toThrow("expired"); expect(requests).toBe(1);
});
test("cosign receives only the selected host through a private temporary configuration", async () => {
  const root = await directory(), helper = join(root, "cosign"), capture = join(root, "capture.json");
  await writeFile(helper, `#!${process.execPath}\nimport {readFile,stat} from 'node:fs/promises';const p=process.env.DOCKER_CONFIG+'/config.json';await Bun.write(${JSON.stringify(capture)},JSON.stringify({path:p,mode:(await stat(p)).mode&511,config:JSON.parse(await readFile(p,'utf8'))}));`, { mode: 0o755 });
  const provider = registryCredentials(["github"], { env: { GITHUB_TOKEN: "SECRET" } });
  await cosignCommand(helper, ["verify", `ghcr.io/org/app@sha256:${"a".repeat(64)}`], 5000, false, provider);
  const captured = JSON.parse(await readFile(capture, "utf8")); expect(captured.mode).toBe(0o600);
  expect(Object.keys(captured.config.auths)).toEqual(["ghcr.io"]);
  expect(captured.config.auths["ghcr.io"].auth).toBe(Buffer.from("x-access-token:SECRET").toString("base64"));
  await expect(stat(captured.path)).rejects.toThrow();
});


test("explicit Docker hosts normalize HTTPS default ports and do not materialize helper secrets for cosign", async () => {
  const file = join(await directory(), "config.json");
  await writeFile(file, JSON.stringify({auths:{"ghcr.io:443":{auth:Buffer.from("user:secret").toString("base64")}}}));
  const provider = registryCredentials(["docker"], {env:{BUNKO_DOCKER_CONFIG:file}});
  expect(await provider("ghcr.io")).toMatchObject({username:"user",password:"secret"}); expect(provider.bridge).toBe(false);
});


test("malformed matching Docker entries cannot fall through to another identity", async () => {
  const file = join(await directory(), "config.json");
  for (const entry of [null, false, 0, ""]) {
    await writeFile(file, JSON.stringify({ auths: { "ghcr.io": entry } }));
    await expect(registryCredentials(["docker", "github"], { env: { BUNKO_DOCKER_CONFIG: file, GITHUB_TOKEN: "OTHER" } })("ghcr.io")).rejects.toThrow("Docker auth entry");
  }
});

test("cosign rejects non-finite credential expiry before invoking its process", async () => {
  for (const expires of [NaN, Infinity, -Infinity]) {
    await expect(cosignCommand("never-executed", ["verify", `ghcr.io/org/app@sha256:${"a".repeat(64)}`], 1000, false, async () => ({ username: "u", password: "p", expires }))).rejects.toThrow("expired");
  }
});

test("refresh does not join or get overwritten by an older lookup", async () => {
  const file = join(await directory(), "config.json");
  await writeFile(file, JSON.stringify({ credsStore: "test" }));
  const started = Promise.withResolvers<void>(), old = Promise.withResolvers<void>();
  let calls = 0;
  const provider = registryCredentials(["docker"], { env: { BUNKO_DOCKER_CONFIG: file }, helper: async () => {
    if (++calls === 1) { started.resolve(); await old.promise; return { username: "u", password: "old" }; }
    return { username: "u", password: "new" };
  } });
  const initial = provider("ghcr.io"); await started.promise;
  try {
    expect((await provider("ghcr.io", true))?.password).toBe("new");
  } finally { old.resolve(); }
  expect((await initial)?.password).toBe("old");
  expect((await provider("ghcr.io"))?.password).toBe("new");
  expect(calls).toBe(2);
});

test.each(["docker", "podman"])("%s repository credentials never become host credentials", async (source) => {
  const file = join(await directory(), "config.json");
  await writeFile(file, JSON.stringify({ credsStore: "test", auths: { "ghcr.io/private": { auth: "dTpw" } } }));
  const provider = registryCredentials([source], { env: { BUNKO_DOCKER_CONFIG: file, REGISTRY_AUTH_FILE: file } });
  await expect(provider("ghcr.io")).rejects.toThrow("Repository-scoped");
});

test.each(["docker", "podman"])("mixed %s sources preserve helper references for cosign", async (source) => {
  const root = await directory(), file = join(root, "config.json"), executable = join(root, "cosign"), capture = join(root, "capture.json");
  await writeFile(file, JSON.stringify({ credHelpers: { "ghcr.io": "test" } }));
  await writeFile(executable, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(capture)},await Bun.file(process.env.DOCKER_CONFIG+'/config.json').text());`, { mode: 0o755 });
  const provider = registryCredentials([source, "github"], { env: { BUNKO_DOCKER_CONFIG: file, REGISTRY_AUTH_FILE: file, GITHUB_TOKEN: "OTHER" }, helper: async () => ({ username: "u", password: "HELPER_SECRET" }) });
  await cosignCommand(executable, ["verify", `ghcr.io/org/app@sha256:${"a".repeat(64)}`], 5000, false, provider);
  expect(JSON.parse(await readFile(capture, "utf8"))).toEqual({ credHelpers: { "ghcr.io": "test" } });
});
