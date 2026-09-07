import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkConfig, doctor } from "../packages/bunko/diagnostics.ts";
import { validateCommandOptions } from "../packages/bunko/command-options.ts";
import { project, temporary } from "./helpers.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

test("offline diagnostics validate configuration without exposing configured values", async () => {
  const root = await temporary(); directories.push(root);
  const source = await project(join(root, "app"));
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "app", module: "src/server.ts", bunko: { env: { SECRET: "do-not-print" }, build: { define: { SECRET: '"another-secret"' } } } }));
  await writeFile(join(source, ".npmrc"), "//registry.npmjs.org/:_authToken=${BUNKO_DIAGNOSTIC_MISSING_TOKEN}\n");
  const result = await doctor({ path: source });
  expect(result.targets[0]!.environmentKeys).toEqual(["SECRET"]);
  expect(JSON.stringify(result)).not.toContain("do-not-print"); expect(JSON.stringify(result)).not.toContain("another-secret");
  expect(result.toolchain.version).toMatch(/^1\.3\./); expect(result.unchecked).toContain("registry credentials and connectivity");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "app", module: "src/server.ts", dependencies: { example: "1.0.0" } }));
  await expect(checkConfig({ path: source })).rejects.toThrow("text bun.lock");
});

test("command option validation rejects ignored flags including explicit negative booleans", async () => {
  for (const [command, flag] of [["prune", "push"], ["push-layout", "no-push"], ["check-base", "sbom"], ["build", "namespace"], ["doctor", "repo"], ["pack-deps", "cache-dir"]]) {
    expect(() => validateCommandOptions(command!, [flag!])).toThrow("not supported");
  }
  validateCommandOptions("build", ["no-push", "jobs"]);
  const child = Bun.spawn([process.execPath, resolve("packages/bunko/cli.ts"), "push-layout", "/nonexistent", "--repo", "registry.test/demo", "--push=false"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(1); expect(stdout).toBe(""); expect(stderr).toContain("not supported by push-layout");
});

test("push-layout verifies attachments and blobs before any registry mutation", async () => {
  const { build } = await import("../packages/bunko/build.ts"), { pushLayout } = await import("../packages/bunko/push-layout.ts");
  const { baseLayout } = await import("./helpers.ts"), { MockRegistry } = await import("./mock-registry.ts");
  const { BlobStore } = await import("../packages/oci/blob-store.ts");
  const root = await temporary(); directories.push(root);
  const source = await project(join(root, "app")), base = await baseLayout(join(root, "base")), output = join(root, "image"), remote = new MockRegistry();
  const result = await build({ path: source, baseLayout: base, output, push: false, localCache: false, sbom: true, provenance: true, gitMetadata: false });
  const registry = { fetcher: remote.fetch, credentials: async () => undefined };
  expect((await pushLayout(output, "registry.test/layout", ["test"], registry)).published).toBe(true);
  remote.requests.splice(0);
  await writeFile(new BlobStore(output).path(result.attestations![0]!.manifest.digest), "corrupt");
  await expect(pushLayout(output, "registry.test/corrupt", ["test"], registry)).rejects.toThrow();
  expect(remote.requests).toHaveLength(0);
});

test("push-layout reports an image root published before an attachment failure", async () => {
  const { build } = await import("../packages/bunko/build.ts"), { pushLayout } = await import("../packages/bunko/push-layout.ts");
  const { baseLayout } = await import("./helpers.ts"), { MockRegistry } = await import("./mock-registry.ts");
  const root = await temporary(); directories.push(root);
  const source = await project(join(root, "app")), base = await baseLayout(join(root, "base")), output = join(root, "image"), remote = new MockRegistry(), report = join(root, "publication.json");
  const result = await build({ path: source, baseLayout: base, output, push: false, localCache: false, sbom: true, gitMetadata: false });
  const blocked = result.attestations![0]!.manifest.digest;
  await expect(pushLayout(output, "registry.test/partial", ["test"], { credentials: async () => undefined, fetcher: (url, init) => {
    if (init?.method === "PUT" && new URL(url).pathname.endsWith(`/manifests/${blocked}`)) return Promise.resolve(new Response(null, { status: 403 }));
    return remote.fetch(url, init);
  } }, report)).rejects.toThrow("image root was published");
  const data = await Bun.file(report).json();
  expect(data.status).toBe("failed"); expect(data.publication.published).toBe(true); expect(data.publication.reference).toContain(result.root.digest);
});
