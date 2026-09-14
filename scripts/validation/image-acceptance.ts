import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BuildResult } from "../../packages/bunko/build.ts";
import { mkdtemp, runInvocation } from "../../packages/runtime/invocation.ts";
import { checked, run } from "./acceptance-command.ts";

process.exitCode = await runInvocation(async () => {
  const structureTest = process.env.BUNKO_STRUCTURE_TEST_PATH ?? "container-structure-test";
  await checked([structureTest, "version"]);
  await checked(["docker", "compose", "version"]);
  // Structure-test reads DOCKER_HOST but does not select Docker CLI contexts.
  const dockerHost = process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT ? process.env.DOCKER_HOST
    : await checked(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  assert.ok(dockerHost.startsWith("unix://"), "This experiment requires a local Docker Unix socket");
  const platforms = (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",");
  assert.ok(platforms.length > 0 && new Set(platforms).size === platforms.length && platforms.every((p) => ["linux/amd64", "linux/arm64"].includes(p)), "Invalid platforms");
  const root = await mkdtemp(join(tmpdir(), "bunko-image-acceptance-"));
  const fixture = resolve("examples/image-acceptance"), tags = new Set<string>();
  const checks: { platform: string; scenario: string; manifest: string; config: string; runtimeImage: string; structure: string; behavior: string }[] = [];
  let status = "failed";
  try {
    for (const variant of ["working", "missing-dependency"]) {
      const source = join(root, variant);
      await cp(fixture, source, { recursive: true, filter: (path) => !path.split("/").includes("node_modules") });
      if (variant === "missing-dependency") {
        const path = join(source, "packages/lazy/package.json");
        const manifest = JSON.parse(await readFile(path, "utf8")); delete manifest.dependencies;
        await writeFile(path, JSON.stringify(manifest));
        // The root development dependency masks the missing declaration in a hoisted checkout.
        await checked([process.execPath, "install", "--ignore-scripts", "--linker=hoisted"], { cwd: source });
        assert.equal(await checked([process.execPath, "-e", 'console.log(require("@acceptance/lazy").run())'], { cwd: join(source, "app") }), "driver-ready");
      }
      for (const platform of platforms) {
        const id = randomUUID(), repository = `bunko.local/acceptance-${id}`;
        const archive = join(root, `${id}.tar`), report = join(root, `${id}.json`);
        await checked([process.execPath, resolve("dist/bunko.js"), "build", source, "--target", "app", "--mode", "bundle",
          "--base", "oven/bun@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9", "--platform", platform,
          "--bun-path", process.execPath, "--repo", repository, "--bare", "--tag", "test", "--push=false", "--tarball", archive,
          "--oci-layout", join(root, `${id}-layout`), "--report", report, "--no-cache", "--git-metadata=false"], { timeoutMs: 300_000 });
        const built = JSON.parse(await readFile(report, "utf8")) as BuildResult;
        assert.equal(built.schemaVersion, 2); assert.equal(built.images.length, 1);
        const image = built.images[0]!;
        assert.deepEqual(image.entrypoints, { server: "/app/src/server.js", worker: "/app/src/worker.js" });
        const tag = `${repository}:sha256-${built.root.digest.slice(7)}`;
        tags.add(tag);
        await checked(["docker", "load", "--input", archive]);
        const runtimeImage = JSON.parse(await checked(["docker", "image", "inspect", tag]))[0].Id as string;
        // Docker's containerd store can expose a synthesized manifest as Id. Verify the actual config bytes instead.
        const saved = join(root, `${id}-saved.tar`);
        await checked(["docker", "image", "save", "--output", saved, runtimeImage]);
        const config = await checked(["python3", "-c", "import hashlib,json,sys,tarfile\nwith tarfile.open(sys.argv[1]) as t:\n m=json.load(t.extractfile('manifest.json')); assert len(m)==1\n print('sha256:'+hashlib.sha256(t.extractfile(m[0]['Config']).read()).hexdigest())", saved]);
        assert.equal(config, image.config.digest, "Loaded image differs from the build report");
        await rm(saved);
        await checked([structureTest, "test", "--image", runtimeImage, "--platform", platform, "--config", join(fixture, "structure.yaml"),
          "--output", "json", "--test-report", join(root, `${id}-structure.json`)], { env: { ...process.env, DOCKER_HOST: dockerHost } });
        const structure = JSON.parse(await readFile(join(root, `${id}-structure.json`), "utf8"));
        assert.equal(structure.Total, 6, "Not all declared structure checks ran");
        assert.equal(structure.Pass, 6); assert.equal(structure.Fail, 0);
        const scenarios = variant === "working" ? ["working", "empty-catalog"] : ["missing-dependency"];
        for (const scenario of scenarios) {
          const project = `bunko-acceptance-${randomUUID()}`;
          const compose = ["docker", "compose", "--project-name", project, "--file", join(fixture, "compose.yaml")];
          const env = { ...process.env, ACCEPTANCE_IMAGE: runtimeImage, ACCEPTANCE_PLATFORM: platform,
            CATALOG_LOCATION: scenario === "empty-catalog" ? "module" : "explicit",
            PROBE_KIND: scenario === "missing-dependency" ? "dependency" : scenario === "empty-catalog" ? "catalog" : "all" };
          try {
            const result = await run([...compose, "up", "--no-build", "--exit-code-from", "probe", "--abort-on-container-exit"], { env, timeoutMs: 60_000 });
            const logs = await checked([...compose, "logs", "--no-color", "probe"], { env });
            assert.ok(logs.includes("READINESS_PASSED"), "Startup did not reach the behavioral check");
            if (scenario === "working") {
              assert.equal(result.code, 0, result.stdout + result.stderr);
              assert.ok(logs.includes("APPLICATION_PROBE_PASSED"));
            } else {
              assert.equal(result.code, 1, result.stdout + result.stderr);
              assert.ok(logs.includes(scenario === "empty-catalog" ? "CATALOG_CONTENT_FAILED" : "DEPENDENCY_HTTP_FAILED"), logs);
              assert.ok(!logs.includes("APPLICATION_PROBE_PASSED"));
            }
            checks.push({ platform, scenario, manifest: image.manifest.digest, config, runtimeImage, structure: "passed",
              behavior: scenario === "working" ? "passed" : "expected-failure" });
            console.log(JSON.stringify(checks.at(-1)));
          } catch (error) {
            const logs = await run([...compose, "logs", "--no-color"], { env, cleanup: true, timeoutMs: 10_000 });
            throw new Error(`Compose acceptance failed:\n${logs.stdout}${logs.stderr}`, { cause: error });
          } finally {
            await checked([...compose, "down", "--volumes", "--remove-orphans"], { env, cleanup: true, timeoutMs: 30_000 });
          }
        }
      }
    }
    assert.equal(checks.length, platforms.length * 3);
    status = "passed";
    return 0;
  } finally {
    const cleanup = await Promise.allSettled([...tags].map((tag) => checked(["docker", "image", "rm", tag], { cleanup: true })));
    const cleanupFailed = cleanup.some((item) => item.status === "rejected");
    const result = { schemaVersion: 1, status: cleanupFailed ? "failed" : status, checks, cleanup: cleanupFailed ? "failed" : "passed" };
    if (process.env.BUNKO_SMOKE_REPORT) await writeFile(process.env.BUNKO_SMOKE_REPORT, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    await rm(root, { recursive: true, force: true });
    if (cleanupFailed) throw new Error("Could not remove all acceptance images");
  }
});
