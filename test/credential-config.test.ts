import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialLogin, editCredentialConfig, passwordFromStdin } from "../packages/oci/credential-config.ts";
import { registryCredentials } from "../packages/oci/credential-sources.ts";
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function file() { const root = await mkdtemp(join(tmpdir(), "bunko-login-test-")); roots.push(root); return join(root, "config.json"); }

test("inline login preserves unrelated keys, writes mode 0600, and removes Docker Hub aliases", async () => {
  const config = await file(); await writeFile(config, JSON.stringify({ feature: { retained: true }, auths: { "index.docker.io": { auth: "b2xkOnNlY3JldA==" }, "elsewhere.test": { auth: "dTpw" } } }));
  await credentialLogin("docker.io", { config, username: "user", password: "secret:with:colons" });
  const content = JSON.parse(await readFile(config, "utf8")); expect(content.feature).toEqual({ retained: true });
  expect(content.auths["index.docker.io"]).toBeUndefined(); expect(content.auths["elsewhere.test"]).toEqual({ auth: "dTpw" });
  expect((await lstat(config)).mode & 0o777).toBe(0o600);
  expect(await registryCredentials(["docker"], { env: { BUNKO_DOCKER_CONFIG: config } })("registry-1.docker.io")).toMatchObject({ username: "user", password: "secret:with:colons" });
  await credentialLogin("index.docker.io", { config }, true);
  expect(Object.keys(JSON.parse(await readFile(config, "utf8")).auths)).toEqual(["elsewhere.test"]);
});
test("helper login stores through the authoritative helper and logout erases while preserving helper policy", async () => {
  const config = await file(); await credentialLogin("ghcr.io", { config, helper: "test-helper" });
  const calls: unknown[] = [];
  const helperWriter = async (helper: string, operation: "store" | "erase", input: string) => { calls.push([helper, operation, input]); };
  await credentialLogin("ghcr.io", { config, username: "user", password: "secret", helperWriter });
  expect(calls[0]).toEqual(["test-helper", "store", JSON.stringify({ ServerURL: "ghcr.io", Username: "user", Secret: "secret" })]);
  expect(await readFile(config, "utf8")).not.toContain("secret");
  await credentialLogin("ghcr.io", { config, helperWriter }, true); expect(calls[1]).toEqual(["test-helper", "erase", "ghcr.io"]);
  expect(JSON.parse(await readFile(config, "utf8")).credHelpers).toEqual({ "ghcr.io": "test-helper" });
});
test("helper failure retains configuration and global store logout retains other registry policy", async () => {
  const config = await file(), initial = JSON.stringify({ credsStore: "test-helper", auths: { "ghcr.io": { auth: "dTpw" } }, retain: 1 }); await writeFile(config, initial);
  await expect(credentialLogin("ghcr.io", { config, helperWriter: async () => { throw new Error("SECRET_HELPER_OUTPUT"); } }, true)).rejects.toThrow("configuration was not changed");
  expect(await readFile(config, "utf8")).toBe(initial);
  await credentialLogin("ghcr.io", { config, helperWriter: async () => {} }, true);
  expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ credsStore: "test-helper", auths: {}, retain: 1 });
});
test("symlink, read-only and malformed configuration cannot be replaced", async () => {
  const config = await file(), target = `${config}.target`; await writeFile(target, "{}"); await symlink(target, config);
  await expect(credentialLogin("ghcr.io", { config, username: "u", password: "p" })).rejects.toThrow("not a link"); expect(await readFile(target, "utf8")).toBe("{}");
  await rm(config); await writeFile(config, "{}"); await chmod(config, 0o400);
  await expect(credentialLogin("ghcr.io", { config, username: "u", password: "p" })).rejects.toThrow("writable");
  await chmod(config, 0o600); await writeFile(config, "SECRET_BAD_JSON");
  await expect(credentialLogin("ghcr.io", { config, username: "u", password: "p" })).rejects.toThrow("Invalid credential configuration JSON");
  expect(await readdir(join(config, ".."))).toEqual(expect.arrayContaining(["config.json"]));
  expect((await readdir(join(config, ".."))).some((name) => name.includes("bunko-"))).toBe(false);
});
test("concurrent bunko writers fail clearly and a noncooperating external edit is preserved", async () => {
  const config = await file(); await writeFile(config, "{}");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => entered = resolve), finish = new Promise<void>((resolve) => release = resolve);
  const first = editCredentialConfig(config, async () => { entered(); await finish; });
  await started;
  await expect(credentialLogin("ghcr.io", { config, username: "u", password: "p" })).rejects.toThrow("locked");
  await writeFile(config, '{"external":true}'); release(); await expect(first).rejects.toThrow("changed while editing");
  expect(await readFile(config, "utf8")).toBe('{"external":true}');
});
test("Podman source is explicit, preserves host scopes, and rejects repository scope broadening", async () => {
  const config = await file(); await writeFile(config, JSON.stringify({ auths: { "ghcr.io": { auth: Buffer.from("user:secret").toString("base64") } } }));
  const env = { REGISTRY_AUTH_FILE: config };
  expect(await registryCredentials(["podman"], { env })("ghcr.io")).toMatchObject({ username: "user", source: "podman" });
  await writeFile(config, JSON.stringify({ auths: { "ghcr.io/org/repo": { auth: "dTpw" } } }));
  await expect(registryCredentials(["podman"], { env })("ghcr.io")).rejects.toThrow("Repository-scoped");
  await expect(registryCredentials(["podman", "github"], { env: { REGISTRY_AUTH_FILE: config + ".missing", GITHUB_TOKEN: "TOKEN" } })("ghcr.io")).rejects.toThrow("Cannot read Podman");
});
test("password stdin is bounded and only its final line ending is removed", async () => {
  expect(await passwordFromStdin(new Response(" space-preserved \r\n").body!)).toBe(" space-preserved ");
  await expect(passwordFromStdin(new Response("x".repeat(256 * 1024 + 1)).body!)).rejects.toThrow("size limit");
  const config = await file();
  await expect(credentialLogin("ghcr.io", { config, username: "u", password: "two\nlines" })).rejects.toThrow("single password");
});


test("Podman empty helper result remains authoritative and unrelated malformed hosts are ignored", async () => {
  const config = await file();
  await writeFile(config, JSON.stringify({ credHelpers: { "ghcr.io:443": "test" }, auths: { "bad host": {} } }));
  expect(await registryCredentials(["podman", "github"], { env: { REGISTRY_AUTH_FILE: config, GITHUB_TOKEN: "OTHER" }, helper: async () => undefined })("ghcr.io")).toBeUndefined();
});

test("CLI login accepts password stdin and logout removes inline credentials without disclosing them", async () => {
  const config = await file();
  const child = Bun.spawn([process.execPath, "packages/bunko/cli.ts", "login", "ghcr.io", "--config", config, "--username", "user", "--password-stdin"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write("CLI_PRIVATE_PASSWORD\n"); child.stdin.end();
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0); expect(output + error).not.toContain("CLI_PRIVATE_PASSWORD");
  expect(await registryCredentials(["docker"], { env: { BUNKO_DOCKER_CONFIG: config } })("ghcr.io")).toMatchObject({ password: "CLI_PRIVATE_PASSWORD" });
  const logout = Bun.spawn([process.execPath, "packages/bunko/cli.ts", "logout", "ghcr.io", "--config", config], { stdout: "pipe", stderr: "pipe" });
  expect(await logout.exited).toBe(0);
  expect(JSON.parse(await readFile(config, "utf8")).auths).toEqual({});
});
