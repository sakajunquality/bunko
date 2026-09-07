import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, buildTargets } from "../packages/bunko/build.ts";
import { discover } from "../packages/bunko/workspace.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { dependencyPlan, installDependencies } from "../packages/bunko/deps.ts";
import { workspaceRuntime } from "../packages/bunko/workspace-runtime.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { runImage } from "./run-image.ts";
import { MockRegistry } from "./mock-registry.ts";
import { baseLayout, temporary } from "./helpers.ts";
import { workspaceFixture } from "./workspace-fixture.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() { const root = await temporary(); directories.push(root); return { root, ...await workspaceFixture(root), base: await baseLayout(join(root, "base")) }; }
function options(f: Awaited<ReturnType<typeof fixture>>, output = "out") { return { path: f.source, baseLayout: f.base, output: join(f.root, output), push: false, localCache: false, gitMetadata: false, installCache: f.cache }; }

describe("M2a workspace builds", () => {
  test("rejects an installed workspace dependency link outside the runtime tree", async () => {
    const f = await fixture(), discovered = await discover({ path: f.source });
    const project = await loadProject({ path: join(f.source, "services/api") }, discovered.workspace);
    const plan = await dependencyPlan(project, f.source), stage = join(f.root, "stage");
    await cp(f.source, stage, { recursive: true });
    await installDependencies(stage, plan, await selectToolchain(), { os: "linux", architecture: "amd64" }, f.cache);
    await symlink("/etc/passwd", join(stage, "node_modules/escape"));
    await expect(workspaceRuntime(stage, "app", { os: "linux", architecture: "amd64" }, plan, project)).rejects.toThrow("escapes the packaged runtime");
  });

  test("reserves the workspace runtime directory against assets", async () => {
    const f = await fixture();
    await mkdir(join(f.source, "services/api/.bunko-workspace"));
    await writeFile(join(f.source, "services/api/.bunko-workspace/collision.txt"), "collision");
    const manifest = f.manifests["services/api"]!;
    await writeFile(join(f.source, "services/api/package.json"), canonicalJSON({ ...manifest, bunko: { ...(manifest.bunko as object), assets: [".bunko-workspace"] } }));
    await expect(buildTargets(options(f))).rejects.toThrow("overlap runtime");
  });

  test("publishes each target only after all builds succeed and reports partial tag failure", async () => {
    const f = await fixture(), registry = new MockRegistry();
    const opts = { ...options(f), output: undefined, push: true, repo: "registry.test/team", registry: { fetcher: registry.fetch, credentials: async () => undefined } };
    const first = await buildTargets(opts);
    expect(first.map((r) => r.publication!.reference)).toEqual(first.map((r) => `registry.test/team/${r.target}@${r.root.digest}`));
    expect(first.every((r) => r.publication?.published && r.publication.pendingTags.length === 0)).toBe(true);
    const before = registry.requests.length;
    await buildTargets({ ...opts, dryRun: true });
    expect(registry.requests.slice(before).every((r) => ["GET", "HEAD"].includes(r.method))).toBe(true);
    const report = join(f.root, "partial.json");
    await expect(buildTargets({ ...opts, report, registry: { credentials: async () => undefined, fetcher: (url, init) => {
      if (init?.method === "PUT" && new URL(url).pathname === "/v2/team/fixture-worker/manifests/latest") return Promise.resolve(new Response(null, { status: 403 }));
      return registry.fetch(url, init);
    } } })).rejects.toThrow("403");
    const partial = JSON.parse(await readFile(report, "utf8"));
    expect(partial.status).toBe("failed");
    expect(partial.targets[0].publication.tags).toEqual(["latest"]);
    expect(partial.targets[1].publication.pendingTags).toEqual(["latest"]);
    expect(partial.pendingTargets).toEqual(["fixture-worker"]);
  });

  test("rejects stale child dependency declarations, membership, and workspace lock references", async () => {
    const f = await fixture();
    const manifest = f.manifests["services/api"]!;
    await writeFile(join(f.source, "services/api/package.json"), canonicalJSON({ ...manifest, dependencies: { ...(manifest.dependencies as object), "fixture-msg": "2.0.0" } }));
    await expect(buildTargets(options(f))).rejects.toThrow("disagree on dependencies");
    await writeFile(join(f.source, "services/api/package.json"), canonicalJSON(manifest));
    await mkdir(join(f.source, "packages/extra"));
    await writeFile(join(f.source, "packages/extra/package.json"), '{"name":"extra"}');
    await expect(buildTargets(options(f))).rejects.toThrow("membership");
    await rm(join(f.source, "packages/extra"), { recursive: true });
    await writeFile(join(f.source, "bun.lock"), canonicalJSON({ ...f.lock, packages: { ...f.lock.packages, "@fixture/shared": ["@fixture/shared@workspace:../../escape"] } }));
    await expect(buildTargets(options(f))).rejects.toThrow("Invalid workspace lock entry");
  });

  test("CLI exports selected services without stdout and rejects ambiguous multi-target output", async () => {
    const f = await fixture();
    await expect(buildTargets({ ...options(f), report: join(f.root, "out/report.json") })).rejects.toThrow("outside the OCI layout");
    expect(await readdir(f.root)).not.toContain("out");
    const run = async (args: string[]) => {
      const process = Bun.spawn([Bun.which("bun")!, "packages/bunko/cli.ts", "build", f.source, "--base-layout", f.base, "--install-cache", f.cache, "--no-cache", "--git-metadata=false", ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      return { stdout, stderr, code };
    };
    expect(await run(["--push=false", "--oci-layout", join(f.root, "cli")])).toMatchObject({ stdout: "", code: 0 });
    const failed = await run(["--push=false", "--tarball", join(f.root, "all.tar")]);
    expect(failed).toMatchObject({ stdout: "", code: 1 });
    expect(failed.stderr).toContain("single target");
  });

  test("discovers enabled targets and supports member paths and explicit selectors", async () => {
    const f = await fixture();
    expect((await discover({ path: f.source })).targets.map((p) => p.path)).toEqual(["services/api", "services/worker"]);
    expect((await discover({ path: join(f.source, "services/api") })).workspace!.directory).toBe(await realpath(f.source));
    expect((await discover({ path: f.source, targets: ["@fixture/worker", "services/worker"] })).targets.map((p) => p.path)).toEqual(["services/worker"]);
    await expect(discover({ path: f.source, targets: ["missing"] })).rejects.toThrow("Unknown");
    await expect(build(options(f))).rejects.toThrow("Multiple workspace targets");
  });

  test("exports and runs two services with distinct versions, peers, and an external workspace", async () => {
    const f = await fixture(), result = await buildTargets({ ...options(f), verifyDeterministic: true, report: join(f.root, "report.json") });
    expect(result.map((r) => r.target)).toEqual(["fixture-api", "fixture-worker"]);
    expect(await runImage(result[0]!, join(f.root, "run-api"))).toBe("api shared one one");
    expect(await runImage(result[1]!, join(f.root, "run-worker"))).toBe("worker shared two two");
    const index = JSON.parse(await readFile(join(f.root, "out/index.json"), "utf8"));
    expect(index.manifests.map((m: any) => m.annotations["org.opencontainers.image.ref.name"])).toEqual(["fixture-api:latest", "fixture-worker:latest"]);
    const report = JSON.parse(await readFile(join(f.root, "report.json"), "utf8"));
    expect(report.schemaVersion).toBe(3);
    expect(report.targets).toHaveLength(2);
    for (const r of result) {
      expect(r.verifiedDeterministic).toBe(true);
      expect(r.images[0]!.inventory.some((p) => p.name === "fixture-dev")).toBe(false);
    }
    expect(await readdir(f.source)).not.toContain("node_modules");
    expect(await Bun.file(join(f.source, "must-not-exist")).exists()).toBe(false);
  });

  test("member build matches root selection, with sourcemaps stable across checkout depths", async () => {
    const f = await fixture(), first = await build({ ...options(f), path: join(f.source, "services/api") });
    const second = await buildTargets({ ...options(f, "selected"), targets: ["@fixture/api"] });
    expect(second[0]!.root.digest).toBe(first.root.digest);
    const copy = join(f.root, "deeper/checkout/workspace"); await cp(f.source, copy, { recursive: true });
    const third = await buildTargets({ ...options(f, "third"), path: copy, targets: ["services/api"] });
    expect(third[0]!.root.digest).toBe(first.root.digest);
  });

  test("a source-only change hits deps/assets; shared package changes invalidate runtime deps", async () => {
    const f = await fixture(), cacheDir = join(f.root, "layer-cache");
    const first = await buildTargets({ ...options(f), localCache: true, cacheDir });
    await writeFile(join(f.source, "services/api/src/server.ts"), (await readFile(join(f.source, "services/api/src/server.ts"), "utf8")).replace("'api'", "'api-v2'"));
    const second = await buildTargets({ ...options(f, "second"), localCache: true, cacheDir });
    expect(second.every((r) => r.cache.every((event) => event.status === "local"))).toBe(true);
    expect(second.map((r) => r.layers[0]!.descriptor.digest)).toEqual(first.map((r) => r.layers[0]!.descriptor.digest));
    await writeFile(join(f.source, "packages/shared/index.ts"), 'export const message = "shared-v2";\n');
    const third = await buildTargets({ ...options(f, "third"), localCache: true, cacheDir });
    expect(third.every((r) => r.cache.some((event) => event.kind === "deps" && event.status === "miss"))).toBe(true);
    expect(await runImage(third[1]!, join(f.root, "run-third"))).toBe("worker shared-v2 two two");
  });

  test("checks every member manifest against the common lock before registry writes", async () => {
    const f = await fixture(), registry = new MockRegistry();
    await writeFile(join(f.source, "packages/shared/package.json"), canonicalJSON({ ...f.manifests["packages/shared"], version: "2.0.0" }));
    await expect(buildTargets({ ...options(f), output: undefined, push: true, repo: "registry.test/team", registry: { fetcher: registry.fetch, credentials: async () => undefined } })).rejects.toThrow("name/version");
    expect(registry.requests).toHaveLength(0);
  });

  test("name collisions and invalid later targets cause no export or publication", async () => {
    const f = await fixture(), registry = new MockRegistry();
    const opts = { ...options(f), push: true, repo: "registry.test/team", registry: { fetcher: registry.fetch, credentials: async () => undefined } };
    await writeFile(join(f.source, "services/worker/package.json"), canonicalJSON({ ...f.manifests["services/worker"], bunko: { imageName: "fixture-api" } }));
    await expect(buildTargets(opts)).rejects.toThrow("name collision");
    await writeFile(join(f.source, "services/worker/package.json"), canonicalJSON(f.manifests["services/worker"]));
    await writeFile(join(f.source, "services/worker/src/server.ts"), 'import "missing-package";');
    await expect(buildTargets(opts)).rejects.toThrow("Bun build failed");
    expect(registry.requests.every((c) => c.method === "GET" || c.method === "HEAD")).toBe(true);
    expect(await Bun.file(join(f.root, "out/index.json")).exists()).toBe(false);
  });
});
