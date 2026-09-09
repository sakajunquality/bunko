import { afterEach, describe, expect, test } from "bun:test";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { installerCredentials, installerOutputTail, redactInstallerOutput } from "../packages/bunko/install-diagnostics.ts";
import { dependencyPlan, installDependencies } from "../packages/bunko/deps.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("installer output redaction", () => {
  test("scrubs npmrc credential keys with and without a registry scope", () => {
    expect(redactInstallerOutput("//registry.npmjs.org/:_authToken=npm_secret_value\n_auth=dXNlcjpwYXNz\n//npm.example/:_password=hunter2\n//npm.example/:always-auth=true\nauth: { _authToken: \"abc123\" }"))
      .toBe("//registry.npmjs.org/:_authToken=<redacted>\n_auth=<redacted>\n//npm.example/:_password=<redacted>\n//npm.example/:always-auth=<redacted>\nauth: { _authToken: <redacted> }");
  });
  test("scrubs Authorization and bearer header values", () => {
    expect(redactInstallerOutput("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload\nauthorization=Basic dXNlcjpwYXNz\nretrying with bearer AbCdEf0123456789")).toBe("Authorization: <redacted>\nauthorization=<redacted>\nretrying with Bearer <redacted>");
    expect(redactInstallerOutput("expected a bearer token")).toBe("expected a bearer token");
  });
  test("scrubs URL userinfo and query strings while keeping the host and path", () => {
    expect(redactInstallerOutput("GET https://user:pass@npm.example/pkg/-/pkg-1.0.0.tgz?token=abc&x=1 failed\n//user:pw@npm.example/ mirror\nsee https://npm.example/docs#anchor and mail admin@npm.example"))
      .toBe("GET https://<redacted>@npm.example/pkg/-/pkg-1.0.0.tgz?<redacted> failed\n//<redacted>@npm.example/ mirror\nsee https://npm.example/docs#anchor and mail admin@npm.example");
  });
  test("scrubs npm and GitHub token shapes", () => {
    const npm = `npm_${"A".repeat(36)}`, ghp = `ghp_${"b".repeat(36)}`, ghs = `ghs_${"c".repeat(40)}`, pat = `github_pat_${"D".repeat(22)}_${"e".repeat(30)}`;
    expect(redactInstallerOutput(`token ${npm} then ${ghp}, ${ghs} and ${pat}; npm_short and ghx_${"f".repeat(36)} stay`)).toBe(`token <redacted> then <redacted>, <redacted> and <redacted>; npm_short and ghx_${"f".repeat(36)} stay`);
  });
  test("replaces the staging root and strips ANSI/CRLF but otherwise preserves diagnostics", () => {
    expect(redactInstallerOutput("error: \x1b[31mfailed\x1b[0m to link /tmp/bunko-abc/runtime-1-amd64/node_modules/left-pad\r\n", ["/tmp/bunko-abc/runtime-1-amd64"])).toBe("error: failed to link <build-root>/node_modules/left-pad\n");
    const plain = "error: failed to download left-pad@1.3.0: 503 Service Unavailable\n  https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz\nFailed to install 1 package\n";
    expect(redactInstallerOutput(plain, [""])).toBe(plain);
  });
  test("tail keeps the last lines, prefers stderr, falls back to stdout, and is empty without output", () => {
    const stderr = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const tail = installerOutputTail(stderr, "ignored stdout", "/tmp/root");
    expect(tail.startsWith("\nInstaller output (redacted, last 20 of 25 lines):\n  line 6\n")).toBe(true);
    expect(tail.endsWith("\n  line 25")).toBe(true); expect(tail).not.toContain("line 5\n"); expect(tail).not.toContain("ignored stdout");
    expect(installerOutputTail("  \n", "bun install v1.4.2\n\nFailed to install 1 package\n", "/tmp/root")).toBe("\nInstaller output (redacted):\n  bun install v1.4.2\n  Failed to install 1 package");
    expect(installerOutputTail("", "", "/tmp/root")).toBe("");
    expect(installerOutputTail(`x${"y".repeat(600)}\n`, "", "/tmp/root")).toBe(`\nInstaller output (redacted):\n  x${"y".repeat(511)}…`);
  });
});

test("a failing install surfaces the redacted tail of the installer output", async () => {
  const root = await temporary(); roots.push(root);
  const fixture = await dependencyFixture(root), toolchain = await selectToolchain();
  const plan = await dependencyPlan(await loadProject({ path: fixture.source }), fixture.source);
  // A live 404 fixture avoids connection-refused retry timing and port reuse races.
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 404 }) });
  const unreachable = `http://127.0.0.1:${probe.port}/`;
  try {
  const stage = join(root, "stage"); await cp(fixture.source, stage, { recursive: true });
  const failure = await installDependencies(stage, { ...plan, registry: unreachable }, toolchain, undefined, join(root, "empty-cache")).then(() => "", (error: Error) => error.message);
  expect(failure).toContain("Bun build dependency install failed (exit 1); check the lock, registry access, and package availability\nInstaller output (redacted");
  expect(failure).toContain("fixture-msg"); expect(failure).not.toContain(stage);
  } finally { await probe.stop(true); }
  const registry = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(`Authorization: Bearer npm_${"z".repeat(36)}`, { status: 401 }) });
  try {
    const production = join(root, "production"); await cp(fixture.source, production, { recursive: true });
    const denied = await installDependencies(production, { ...plan, registry: `http://127.0.0.1:${registry.port}/?token=query-secret` }, toolchain, { os: "linux", architecture: "amd64" }, join(root, "empty-cache")).then(() => "", (error: Error) => error.message);
    expect(denied).toContain("Bun Linux production dependency install failed (exit 1)"); expect(denied).toContain("Installer output (redacted");
    expect(denied).toContain(`http://127.0.0.1:${registry.port}/?<redacted>`); expect(denied).not.toContain("query-secret"); expect(denied).not.toContain("z".repeat(36));
  } finally { await registry.stop(true); }
});

test("quoted headers and expanded custom credentials never survive diagnostics", () => {
  const raw = JSON.stringify({ Authorization: "Basic dXNlcjpwYXNz", _authToken: "private-custom-secret", _password: "another-secret" });
  const redacted = redactInstallerOutput(raw);
  for (const value of ["dXNlcjpwYXNz", "private-custom-secret", "another-secret"]) expect(redacted).not.toContain(value);
  const secrets = installerCredentials("//npm.example/:_authToken=custom+token/secret\n_password=" + Buffer.from("private-password").toString("base64") + "\n");
  const tail = installerOutputTail("rejected custom+token/secret and custom%2Btoken%2Fsecret and private-password", "", "/tmp/stage", 20, secrets);
  for (const value of ["custom+token/secret", "custom%2Btoken%2Fsecret", "private-password"]) expect(tail).not.toContain(value);
});
