/** Real workspace CLI -> Distribution -> verified pull -> Docker runtime. */
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseAllDocuments } from "yaml";
import type { BuildResult } from "../packages/bunko/build.ts";
import { platform as parsePlatform } from "../packages/bunko/config.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { RegistrySource, resolveBase } from "../packages/oci/source.ts";
import { exportDockerArchive, loadArchive } from "../packages/oci/archive.ts";
import { command } from "./command.ts";
import { pullImage } from "./docker-pull.ts";

export async function workspaceSmoke(options: { closure?: boolean; resolve?: boolean; registryPlans?: boolean } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "bunko-workspace-smoke-"));
  const id = randomUUID(), registryName = `bunko-workspace-registry-${id}`;
  const containers = new Set<string>(), images = new Set<string>();
  let registryStarted = false;
  try {
    await pullImage("registry:3");
    await command(["docker", "run", "--pull=never", "--detach", "--name", registryName, "--publish", "127.0.0.1::5000", "registry:3"]);
    registryStarted = true;
    const registryInfo = JSON.parse(await command(["docker", "inspect", registryName]))[0];
    const host = `127.0.0.1:${registryInfo.NetworkSettings.Ports["5000/tcp"][0].HostPort}`, repo = `${host}/workspace`;
    for (let i = 0; ; i++) {
      try { if ((await fetch(`http://${host}/v2/`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* startup */ }
      if (i >= 99) throw new Error("Registry startup failed");
      await Bun.sleep(100);
    }
    const source = join(temporary, "source"), dockerConfig = join(temporary, "docker.json");
    await cp(resolve("examples/workspace"), source, { recursive: true, filter: (path) => !path.split("/").includes("node_modules") });
    await writeFile(dockerConfig, "{}");
    const manifest = join(temporary, "services.yaml");
    if (options.resolve) await writeFile(manifest, "# preserve this comment\nimage: &api bunko://services/api\ncopy: *api\n---\nimage: bunko://services/worker\n");
    const base = "oven/bun@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9";
    async function build(iteration: number, shared = false) {
      const report = join(temporary, `report-${iteration}.json`);
      const args = [process.execPath, resolve(process.env.BUNKO_TEST_CLI ?? "packages/bunko/cli.ts"), "build", source, "--repo", repo, "--cache-repo", `${host}/bunko-cache`, "--base", base, "--platform", "linux/amd64,linux/arm64", "--no-local-cache", "--git-metadata=false", "--insecure-registry", host, "--report", report, "--install-cache", process.env.BUNKO_SMOKE_NPM_CACHE ?? join(temporary, "npm-cache")];
      if (options.registryPlans) {
        // Each build starts with a fresh managed cache; only registry records can supply a warm plan.
        args.splice(args.indexOf("--no-local-cache"), 1, "--cache-dir", join(temporary, `cache-${iteration}`));
      }
      if (options.resolve) args.splice(2, 2, "resolve", "--context", source, "-f", manifest);
      if (options.closure) args.push("--deps-strategy", "closure");
      if (shared) args.push("--shared-deps");
      if (iteration === 1) args.push("--verify-deterministic");
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "inherit", env: { ...process.env, BUNKO_DOCKER_CONFIG: dockerConfig } });
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (code !== 0) throw new Error(`Workspace CLI failed (exit ${code})`);
      const result = JSON.parse(await readFile(report, "utf8")) as { schemaVersion: number; targets: BuildResult[] };
      if (result.schemaVersion !== (options.resolve ? 4 : 3) || result.targets.length !== 2) throw new Error("Expected a two-target report");
      if (options.resolve) {
        const docs = parseAllDocuments(stdout);
        if (docs.length !== 2 || docs.some((d) => d.errors.length) || docs[0]!.toJS().image !== result.targets[0]!.publication!.reference || docs[0]!.toJS().copy !== result.targets[0]!.publication!.reference || docs[1]!.toJS().image !== result.targets[1]!.publication!.reference || !stdout.startsWith("# preserve this comment\n")) throw new Error("Resolve output did not preserve documents/anchors or published references");
      } else if (stdout !== result.targets.map((target) => target.publication!.reference + "\n").join("")) throw new Error("CLI stdout must contain exactly one ordered digest line per target");
      return result.targets;
    }
    const first = await build(1);
    const app = join(source, "services/api/src/server.ts");
    await writeFile(app, (await readFile(app, "utf8")).replace('service: "api"', 'service: "api-v2"'));
    const second = await build(2);
    for (const target of second) {
      // Base inspection and closure plans are metadata lookups, separate from layer hits.
      if (!target.cache.length || !target.cache.filter((event) => ["deps", "assets", "runtime"].includes(event.kind)).every((event) => event.status === "registry")) throw new Error("Expected workspace Registry cache hits");
      if (target.publication!.transfers.some((transfer) => ["deps", "assets"].includes(transfer.kind) && transfer.uploaded !== 0)) throw new Error("Workspace deps/assets uploaded after source-only edit");
    }
    if (options.registryPlans) {
      const api = second.find((target) => target.target === "api")!;
      if (api.cache.filter((event) => event.kind === "deps-plan" && event.status === "registry").length !== 2) throw new Error("Expected registry closure plans on both platforms with fresh local caches");
      if (!api.timings || api.timings.some((event) => event.phase === "install")) throw new Error("Registry closure plan replay repeated installation");
    }
    const shared = options.closure ? await build(3, true) : [];
    if (options.closure) {
      if (second.find((r) => r.target === "worker")!.images.some((i) => i.native.length)) throw new Error("Unrelated API native dependencies leaked into worker closure");
      for (let i = 0; i < shared[0]!.images.length; i++) if (shared[0]!.images[i]!.layers[0]!.descriptor.digest !== shared[1]!.images[i]!.layers[0]!.descriptor.digest) throw new Error("sharedDeps union layers differ");
    }
    const runtime: unknown[] = [];
    for (const [targetIndex, target] of [...second, ...shared].entries()) for (const platform of process.env.BUNKO_SMOKE_PLATFORMS?.split(",") ?? ["linux/amd64", "linux/arm64"]) {
      const name = `bunko-workspace-${id}-${targetIndex}-${target.target}-${platform.split("/")[1]}`;
      const store = new BlobStore(join(temporary, name));
      const pulled = await resolveBase(new RegistrySource(target.publication!.reference, { insecure: [host], credentials: async () => undefined }), parsePlatform(platform), store);
      const tag = `bunko.local/${name}:smoke`, archive = join(temporary, `${name}.tar`);
      await exportDockerArchive(store, pulled.descriptor, archive, tag, 0);
      await loadArchive(archive, tag); images.add(tag);
      await command(["docker", "run", "--detach", "--name", name, "--platform", platform, "--pull=never", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid", "--cap-drop=ALL", "--publish", "127.0.0.1::3000", tag]);
      containers.add(name);
      const info = JSON.parse(await command(["docker", "inspect", name]))[0];
      if (info.Config.User !== "65532:65532") throw new Error("Expected nonroot image");
      const port = info.NetworkSettings.Ports["3000/tcp"][0].HostPort;
      let body: Record<string, unknown> | undefined;
      for (let i = 0; i < 100; i++) {
        try { const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { body = await response.json() as Record<string, unknown>; break; } } catch { /* startup */ }
        await Bun.sleep(100);
      }
      if (!body || body.number !== true || body.message !== "Hello from a shared workspace!" || body.version !== (target.target === "api" ? "7.0.0" : "6.0.0") || body.service !== (target.target === "api" ? "api-v2" : "worker") || (target.target === "api" && body.hash !== 510391394)) throw new Error(`Runtime failed for ${target.target}/${platform}: ${JSON.stringify(body)}; ${await command(["docker", "logs", name])}`);
      await command(["docker", "stop", "--time", "5", name]);
      const state = JSON.parse(await command(["docker", "inspect", name]))[0].State;
      if (state.ExitCode !== 0) throw new Error("Workspace SIGTERM shutdown failed");
      runtime.push({ target: target.target, platform, body, user: info.Config.User, readOnly: true, exitCode: state.ExitCode });
    }
    const report = { base, resolve: Boolean(options.resolve), closure: Boolean(options.closure), shared: shared.map((r) => ({ target: r.target, root: r.root.digest, layers: r.images.map((i) => i.layers[0]!.descriptor.digest) })), first: first.map((r) => ({ target: r.target, root: r.root.digest })), second: second.map((r) => ({ target: r.target, root: r.root.digest, cache: r.cache, transfers: r.publication!.transfers })), runtime };
    if (process.env.BUNKO_SMOKE_REPORT) await writeFile(process.env.BUNKO_SMOKE_REPORT, JSON.stringify(report, null, 2), { flag: "wx" });
    console.log(JSON.stringify(report, null, 2));
    console.log("PASS: workspace CLI, multi-target publication, shared package, distinct versions, native runtime, Registry cache, amd64/arm64 build");
  } finally {
    for (const name of containers) await command(["docker", "rm", "--force", name]).catch(() => {});
    for (const tag of images) await command(["docker", "image", "rm", tag]).catch(() => {});
    if (registryStarted) await command(["docker", "rm", "--force", registryName]).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}
if (import.meta.main) await workspaceSmoke();
