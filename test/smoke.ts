/** Optional interoperability test. Requires Docker with its containerd image store. */
import { randomUUID } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ImageIndex } from "../packages/oci/types.ts";

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit) throw new Error(`${args.slice(0, 3).join(" ")} failed: ${stderr || stdout}`);
  return stdout.trim();
}

async function smoke(layout: string) {
  const temporary = await mkdtemp(join(tmpdir(), "bunko-smoke-"));
  const id = randomUUID();
  const tag = `docker.io/library/bunko-smoke:${id}`;
  const name = `bunko-smoke-${id}`;
  let loaded = false, container = false;
  try {
    const stage = join(temporary, "layout");
    await mkdir(join(stage, "blobs", "sha256"), { recursive: true });
    for (const digest of await readdir(join(layout, "blobs", "sha256"))) {
      const source = join(layout, "blobs", "sha256", digest), destination = join(stage, "blobs", "sha256", digest);
      try { await link(source, destination); } catch { await copyFile(source, destination); }
    }
    await copyFile(join(layout, "oci-layout"), join(stage, "oci-layout"));
    const index: ImageIndex = JSON.parse(await readFile(join(layout, "index.json"), "utf8"));
    if (index.manifests.length !== 1) throw new Error("Smoke test expects one image root");
    index.manifests[0]!.annotations = { "org.opencontainers.image.ref.name": tag, "io.containerd.image.name": tag };
    await writeFile(join(stage, "index.json"), JSON.stringify(index));
    const archive = join(temporary, "image.tar");
    await command(["tar", "-C", stage, "-cf", archive, "oci-layout", "index.json", "blobs"]);
    console.log(await command(["docker", "image", "load", "--platform=linux/amd64", "--input", archive]));
    loaded = true;
    await command(["docker", "run", "--detach", "--pull=never", "--platform=linux/amd64", "--name", name,
      "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid", "--cap-drop=ALL", "--publish", "127.0.0.1::3000", tag]);
    container = true;
    const inspect = JSON.parse(await command(["docker", "inspect", name]))[0];
    if (inspect.Config.User !== "65532:65532") throw new Error("Hello must run as 65532:65532");
    const port = inspect.NetworkSettings.Ports["3000/tcp"][0].HostPort;
    let response = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const result = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        if (result.ok) { response = await result.text(); break; }
      } catch { /* wait for the application to listen */ }
      await Bun.sleep(100);
    }
    if (process.argv.includes("--dependencies")) {
      if (!response) {
        const logs = Bun.spawn(["docker", "logs", name], { stdout: "pipe", stderr: "pipe" });
        throw new Error(`No response: ${await new Response(logs.stdout).text()} ${await new Response(logs.stderr).text()}`);
      }
      const body = JSON.parse(response);
      if (body.number !== true || typeof body.hash !== "number") throw new Error(`Unexpected dependency response: ${response}`);
    } else if (response !== "Hello from bunko!\n") throw new Error(`Unexpected response: ${JSON.stringify(response)}`);
    await command(["docker", "stop", "--time", "5", name]);
    const state = JSON.parse(await command(["docker", "inspect", name]))[0].State;
    if (state.ExitCode !== 0) throw new Error(`SIGTERM did not shut down cleanly: ${state.ExitCode}`);
    console.log(`PASS: ${index.manifests[0]!.digest}, HTTP 200, nonroot, read-only rootfs, SIGTERM exit 0`);
  } finally {
    if (container) await command(["docker", "rm", "--force", name]).catch(() => { });
    if (loaded) await command(["docker", "image", "rm", tag]).catch(() => { });
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const layout = process.argv[2];
  if (!layout) throw new Error("Usage: bun run test:smoke <hello OCI layout directory>");
  await smoke(resolve(layout));
}
