/** Real Distribution + Docker interoperability. Uses only its own temporary registry/containers/tags. */
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { RegistrySource, resolveBase } from "../packages/oci/source.ts";
import { exportDockerArchive, loadArchive } from "../packages/oci/archive.ts";
import { platform as parsePlatform } from "../packages/bunko/config.ts";

import { command } from "./command.ts";
export { command } from "./command.ts";
import { pullImage } from "./docker-pull.ts";

export async function smoke() {
  const temporary = await mkdtemp(join(tmpdir(), "bunko-build-smoke-"));
  const id = randomUUID(), registryName = `bunko-registry-${id}`;
  const containers = new Set<string>(), images = new Set<string>();
  let registryStarted = false;
  try {
    const base = "oven/bun@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9";
    await pullImage("registry:3");
    await command(["docker", "run", "--pull=never", "--detach", "--name", registryName, "--publish", "127.0.0.1::5000", "registry:3"]);
    registryStarted = true;
    const info = JSON.parse(await command(["docker", "inspect", registryName]))[0];
    const port = info.NetworkSettings.Ports["5000/tcp"][0].HostPort;
    const host = `127.0.0.1:${port}`, repo = `${host}/bunko-build`;
    for (let i = 0; ; i++) {
      try { if ((await fetch(`http://${host}/v2/`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* wait for registry */ }
      if (i === 99) throw new Error("Registry did not start");
      await Bun.sleep(100);
    }
    const source = join(temporary, "source");
    await cp(resolve("examples/dependencies"), source, { recursive: true, filter: (path) => !path.split("/").includes("node_modules") });
    const options = { path: source, base, platform: "linux/amd64,linux/arm64", push: true, repo, cacheRepo: repo, bare: true, tags: ["smoke"],
      gitMetadata: false, localCache: false, registry: { insecure: [host], credentials: async () => undefined },
      installCache: process.env.BUNKO_SMOKE_NPM_CACHE ?? join(temporary, "npm-cache"), log: (message: string) => process.stderr.write(message) };
    const start = performance.now();
    const first = await build({ ...options, verifyDeterministic: true });
    const coldMs = Math.round(performance.now() - start);
    const file = join(source, "src/server.ts");
    await writeFile(file, (await readFile(file, "utf8")).replace("Hello from bunko dependencies!", "Hello from bunko dependencies, rebuilt!"));
    const warmStart = performance.now();
    const second = await build(options), warmMs = Math.round(performance.now() - warmStart);
    if (!second.cache.filter((event) => ["deps", "assets", "runtime"].includes(event.kind)).every((event) => event.status === "registry")) throw new Error("Expected registry cache hits");
    if (second.publication!.transfers.some((transfer) => ["deps", "assets"].includes(transfer.kind) && transfer.uploaded !== 0)) throw new Error("Deps/assets were uploaded again after a source-only change");
    let reusedLog = "";
    const third = await build({ ...options, log: (message) => { reusedLog += message; } });
    if (third.root.digest !== second.root.digest || !third.cache.some((event) => event.kind === "app" && event.status === "registry")) throw new Error("Expected a stable remote application cache hit");
    if (reusedLog.includes("Bundling") || reusedLog.includes("Preparing build dependencies")) throw new Error("Application cache hit repeated build preparation");
    const reference = second.publication!.reference;
    const runtime: unknown[] = [];
    const platforms = process.env.BUNKO_SMOKE_PLATFORMS?.split(",") ?? ["linux/amd64", "linux/arm64"];
    for (const platform of platforms) {
      // Pull through the host-side Distribution client. Docker Desktop's daemon
      // may live in a different loopback namespace than the published host port.
      const pulledStore = new BlobStore(join(temporary, `pull-${platform.split("/")[1]}`));
      const pulled = await resolveBase(new RegistrySource(reference, options.registry), parsePlatform(platform), pulledStore);
      const tag = `bunko.local/pulled-${id}:${platform.split("/")[1]}`;
      const archive = join(temporary, `pull-${platform.split("/")[1]}.tar`);
      await exportDockerArchive(pulledStore, pulled.descriptor, archive, tag, 0);
      await loadArchive(archive, tag);
      images.add(tag);
      const name = `bunko-runtime-${id}-${platform.split("/")[1]}`;
      await command(["docker", "run", "--detach", "--name", name, "--platform", platform, "--pull=never", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid", "--cap-drop=ALL", "--publish", "127.0.0.1::3000", tag]);
      containers.add(name);
      const inspect = JSON.parse(await command(["docker", "inspect", name]))[0];
      if (inspect.Config.User !== "65532:65532") throw new Error("Image must run as nonroot");
      const appPort = inspect.NetworkSettings.Ports["3000/tcp"][0].HostPort;
      let body: Record<string, unknown> | undefined;
      for (let i = 0; i < 100; i++) {
        try {
          const response = await fetch(`http://127.0.0.1:${appPort}/`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) { body = await response.json() as Record<string, unknown>; break; }
        } catch { /* wait for application */ }
        await Bun.sleep(100);
      }
      if (!body || body.number !== true || typeof body.hash !== "number" || body.message !== "Hello from bunko dependencies, rebuilt!") {
        throw new Error(`Application failed on ${platform}: ${await command(["docker", "logs", name])}; state: ${JSON.stringify((JSON.parse(await command(["docker", "inspect", name]))[0]).State)}`);
      }
      await command(["docker", "stop", "--time", "5", name]);
      const state = JSON.parse(await command(["docker", "inspect", name]))[0].State;
      if (state.ExitCode !== 0) throw new Error("SIGTERM shutdown failed");
      runtime.push({ platform, response: body, user: inspect.Config.User, readOnly: true, exitCode: state.ExitCode });
    }
    // Exercise the product Docker archive/loader against the same application.
    const local = await build({ ...options, push: false, repo: undefined, platform: platforms[0], local: true, registryCache: false, cacheDir: join(temporary, "cache"), localCache: true });
    images.add(local.localReference!);
    const report = { base, coldMs, warmMs, first: { root: first.root, transfers: first.publication!.transfers }, second: { root: second.root, transfers: second.publication!.transfers, cache: second.cache }, runtime, localReference: local.localReference };
    if (process.env.BUNKO_SMOKE_REPORT) await writeFile(process.env.BUNKO_SMOKE_REPORT, canonicalJSON(report), { flag: "wx" });
    console.log(JSON.stringify(report, null, 2));
    console.log("PASS: real registry push/pull, npm/native runtime, deps/assets reuse, multi-platform, Docker archive/load");
  } finally {
    for (const container of containers) await command(["docker", "rm", "--force", container]).catch(() => {});
    for (const image of images) await command(["docker", "image", "rm", image]).catch(() => {});
    if (registryStarted) await command(["docker", "rm", "--force", registryName]).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}
if (import.meta.main) await smoke();
