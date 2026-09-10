import { afterEach, expect, test } from "bun:test";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { supportedBunVersion } from "../packages/bunko/bun-version.ts";
import { assertToolchain, toolchainRequirements } from "../packages/bunko/toolchain-policy.ts";
import { assertLockToolchain, validateLock } from "../packages/bunko/deps.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { checkConfig, doctor } from "../packages/bunko/diagnostics.ts";
import { build } from "../packages/bunko/build.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { workspaceFixture } from "./workspace-fixture.ts";
import { baseLayout, temporary } from "./helpers.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("stable Bun 1.3 and 1.4 declarations retain explicit range boundaries", () => {
  for (const version of ["1.3.13", "1.3.14", "1.4.0", "1.4.1", "1.4.2"]) {
    expect(supportedBunVersion(version)).toBe(true);
    expect(toolchainRequirements([{ packageManager: `bun@${version}` }], { version }).version).toBe(version);
  }
  for (const version of ["1.3.10", "1.3.11", "1.3.12", "1.5.0", "2.0.0", "1.4.0-canary", "1.4.02", "^1.4.0"]) {
    expect(supportedBunVersion(version)).toBe(false);
    expect(() => toolchainRequirements([], { version })).toThrow();
  }
});

test("retired toolchains fail before registry access", async () => {
  const root = await temporary(); roots.push(root); const fixture = await dependencyFixture(root);
  let requests = 0;
  for (const version of ["1.3.11", "1.3.12"]) {
    const executable = join(root, `bun-${version}`);
    await writeFile(executable, `#!/bin/sh\nprintf '${version}+012345678\\n'\n`); await chmod(executable, 0o755);
    await expect(selectToolchain(executable)).rejects.toThrow("Bun >=1.3.13 <1.5");
    await expect(build({ path: fixture.source, bunPath: executable, push: false, output: join(root, "out"), registry: { fetcher: async () => { requests++; throw new Error("No network expected"); } } })).rejects.toThrow("Bun >=1.3.13 <1.5");
    expect(() => toolchainRequirements([{ packageManager: `bun@${version}` }])).toThrow("exact supported version");
  }
  expect(requests).toBe(0);
});

test("toolchain mismatch messages name the selected binary, both versions and the declaration source", async () => {
  const selected = { path: "/opt/bun/bin/bun", version: "1.3.13", revision: "bf2e2cecf" };
  const pinned = toolchainRequirements([{ packageManager: "bun@1.4.0" }]);
  expect(pinned).toEqual({ version: "1.4.0", versionSource: "package.json#packageManager", revision: undefined, ranges: [], rangeSources: [] });
  expect(() => assertToolchain(pinned, selected)).toThrow("Selected Bun 1.3.13 (/opt/bun/bin/bun) does not match the declared version 1.4.0 (package.json#packageManager). Install Bun 1.4.0 and select it with --bun-path, or change the declaration.");
  expect(() => assertToolchain(toolchainRequirements([], { version: "1.4.0" }), selected)).toThrow("declared version 1.4.0 (bunko.toolchain.version)");
  expect(() => assertToolchain(toolchainRequirements([], { revision: "0123456789abcdef" }), selected)).toThrow("Selected Bun 1.3.13 (/opt/bun/bin/bun) revision bf2e2cecf does not match the declared revision 0123456789abcdef (bunko.toolchain.revision). Install that Bun build and select it with --bun-path, or change the declaration.");
  const ranged = toolchainRequirements([{ engines: { bun: ">=1.3.13" } }, { engines: { bun: ">=1.4.0" } }], undefined, ["package.json", "services/api/package.json"]);
  expect(ranged.ranges).toEqual([">=1.3.13", ">=1.4.0"]); expect(ranged.rangeSources).toEqual(["package.json#engines.bun", "services/api/package.json#engines.bun"]);
  expect(() => assertToolchain(ranged, selected)).toThrow("Selected Bun 1.3.13 (/opt/bun/bin/bun) does not satisfy engines.bun >=1.4.0 (services/api/package.json#engines.bun). Install a Bun version in that range and select it with --bun-path, or change the declaration.");
  expect(() => toolchainRequirements([{ packageManager: "bun@1.3.13" }, { packageManager: "bun@1.4.0" }], { version: "1.4.2" }, ["package.json", "services/api/package.json"])).toThrow("Conflicting Bun toolchain version declarations: 1.4.2 (bunko.toolchain.version), 1.3.13 (package.json#packageManager), 1.4.0 (services/api/package.json#packageManager)");
  expect(() => assertToolchain(toolchainRequirements([{ packageManager: "bun@1.3.13", engines: { bun: ">=1.3.13 <1.5" } }], { revision: selected.revision }), selected)).not.toThrow();
  const root = await temporary(); roots.push(root); const fixture = await workspaceFixture(root);
  const memberPath = join(fixture.source, "services/api/package.json"), member = JSON.parse(await readFile(memberPath, "utf8"));
  member.packageManager = "bun@1.4.0"; member.engines = { bun: ">=1.3.13 <1.5" }; await writeFile(memberPath, JSON.stringify(member));
  const requirements = (await checkConfig({ path: join(fixture.source, "services/api") })).targets[0]!.toolchainRequirements;
  expect(requirements.versionSource).toBe("services/api/package.json#packageManager"); expect(requirements.rangeSources).toEqual(["services/api/package.json#engines.bun"]);
});

test("lock v2 retains integrity/source validation and fails on old toolchains before registry access", async () => {
  const root = await temporary(); roots.push(root); const fixture = await dependencyFixture(root);
  const manifest = JSON.parse(await readFile(join(fixture.source, "package.json"), "utf8"));
  const lock = { ...fixture.lock, lockfileVersion: 2 };
  expect(() => validateLock(manifest, lock)).not.toThrow();
  expect(() => validateLock(manifest, { ...lock, packages: { bad: ["bad@1.0.0", "", {}, ""] } })).toThrow("integrity-free");
  expect(() => validateLock(manifest, { ...lock, packages: { bad: ["bad@file:../escape"] } })).toThrow("non-registry");
  await writeFile(join(fixture.source, "bun.lock"), JSON.stringify(lock));
  const old = join(root, "old-bun"); await writeFile(old, '#!/bin/sh\nprintf "1.3.13+bf2e2cecf\\n"\n'); await chmod(old, 0o755);
  expect((await checkConfig({ path: fixture.source })).targets[0]!.lockfileVersion).toBe(2);
  await expect(doctor({ path: fixture.source, bunPath: old })).rejects.toThrow("version 2 requires Bun >=1.4.0");
  let requests = 0;
  await expect(build({ path: fixture.source, bunPath: old, push: false, output: join(root, "out"), registry: { fetcher: async () => { requests++; throw new Error("No network expected"); } } })).rejects.toThrow("version 2 requires Bun >=1.4.0");
  expect(requests).toBe(0);
});

test("Bun 1.4 frozen v2 installs produce deterministic dependency images", async () => {
  const selected = await selectToolchain();
  if (selected.version.startsWith("1.3.")) {
    expect(() => assertLockToolchain({ lock: { lockfileVersion: 2 } }, selected)).toThrow("requires Bun"); return;
  }
  const root = await temporary(); roots.push(root); const fixture = await dependencyFixture(root);
  const text = JSON.stringify({ ...fixture.lock, lockfileVersion: 2 }); await writeFile(join(fixture.source, "bun.lock"), text);
  const result = await build({ path: fixture.source, baseLayout: await baseLayout(join(root, "base")), push: false, output: join(root, "out"), installCache: fixture.cache, localCache: false, gitMetadata: false, verifyDeterministic: true });
  expect(result.verifiedDeterministic).toBe(true);
  expect(result.images[0]!.inventory.map((entry) => entry.name)).toEqual(["fixture-msg"]);
  expect(await readFile(join(fixture.source, "bun.lock"), "utf8")).toBe(text);
});

test("the unmodified Bun 1.4.2 generated lock schema is accepted", async () => {
  const manifest = await Bun.file(new URL("./fixtures/lock-v2/package.json", import.meta.url)).json();
  const lock = Bun.JSONC.parse(await Bun.file(new URL("./fixtures/lock-v2/bun.lock", import.meta.url)).text());
  expect(validateLock(manifest, lock).lockfileVersion).toBe(2);
});
