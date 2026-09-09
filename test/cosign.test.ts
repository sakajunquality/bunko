import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { assertCosign, cosignCommand, signingEnvironment } from "../packages/bunko/cosign.ts";
import { signImages } from "../packages/bunko/attest.ts";
import { build } from "../packages/bunko/build.ts";
import { temporary } from "./helpers.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function helper(code: string) {
  const root = await temporary(); roots.push(root); const path = join(root, "cosign");
  await writeFile(path, `#!${process.execPath}\n${code}`, { mode: 0o755 }); return path;
}

test("cosign preflight accepts stable v3+ and rejects old, prerelease or malformed helper output", async () => {
  for (const gitVersion of ["v3.1.3", "3.0.0", "v4.0.0"]) await assertCosign(await helper(`console.log(JSON.stringify({gitVersion:${JSON.stringify(gitVersion)}}));`));
  for (const gitVersion of ["v2.5.0", "v3.0.0-rc.1", "SECRET_BAD_VERSION"]) {
    await expect(assertCosign(await helper(`console.log(JSON.stringify({gitVersion:${JSON.stringify(gitVersion)}}));`))).rejects.toThrow("stable cosign version 3");
  }
  await expect(assertCosign(await helper('console.log("SECRET_MALFORMED");'))).rejects.toThrow("stable cosign version 3");
});

test("unsupported cosign fails before source discovery or registry publication", async () => {
  let requests = 0;
  await expect(build({ path: "/missing-cosign-fixture", signKey: "private.key", cosignPath: await helper('console.log(JSON.stringify({gitVersion:"v2.5.0"}));'),
    registry: { fetcher: async () => { requests++; throw new Error("Unexpected network"); } } })).rejects.toThrow("stable cosign version 3");
  expect(requests).toBe(0);
});

test("all signing references are validated before any helper runs", async () => {
  const executable = await helper('throw new Error("Helper must not run");');
  await expect(signImages([`registry.test/app@sha256:${"a".repeat(64)}`, "registry.test/app:mutable"], "key", executable)).rejects.toThrow("immutable");
});

test.each([
  ["x509 certificate unknown authority", "TLS trust failure"],
  ["UNAUTHORIZED", "registry authentication or permission failure"],
  ["no matching signatures", "signature verification failure"],
  ["decrypt private key", "key loading or password failure"],
])("cosign diagnostics classify %s without reflecting helper text", async (detail, expected) => {
  const executable = await helper(`console.error(${JSON.stringify(`SECRET_TOKEN ${detail}`)}); process.exit(1);`);
  try { await cosignCommand(executable, ["verify"]); throw new Error("Expected failure"); }
  catch (error) { expect(String(error)).toContain(expected); expect(String(error)).not.toContain("SECRET_TOKEN"); }
});

test("cosign output capture is bounded and deadline or signal termination cannot report success", async () => {
  expect((await cosignCommand(await helper('console.log("x".repeat(200000));'), ["version"])).length).toBe(64 * 1024);
  await expect(cosignCommand(await helper('setInterval(() => {}, 1000);'), ["sign"], 100)).rejects.toThrow("timed out");
  await expect(cosignCommand(await helper('process.kill(process.pid, "SIGTERM");'), ["sign"])).rejects.toThrow("cosign sign failed");
});

test("lowercase proxies and intentional empty proxy overrides survive signing isolation", () => {
  const keys = ["http_proxy", "https_proxy", "all_proxy", "no_proxy", "ALL_PROXY", "COSIGN_REPOSITORY"];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "fixture";
    process.env.https_proxy = "";
    const env = signingEnvironment();
    expect(env.http_proxy).toBe("fixture"); expect(env.https_proxy).toBe(""); expect(env.all_proxy).toBe("fixture"); expect(env.no_proxy).toBe("fixture"); expect(env.ALL_PROXY).toBe("fixture");
    expect(env.COSIGN_REPOSITORY).toBeUndefined();
  } finally { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
});
