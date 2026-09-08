/** Read an external mapped file from default and overridden commands on Linux. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { exportDockerArchive, loadArchive } from "../packages/oci/archive.ts";
import { project } from "./helpers.ts";
import { command } from "./command.ts";

const root = await mkdtemp(join(tmpdir(), "bunko-assets-")), tags: string[] = [];
try {
  const context = join(root, "inputs");
  await mkdir(context);
  await writeFile(join(context, "settings.json"), JSON.stringify({message:"external-asset"}));
  const source = await project(join(root, "app"), { bunko: { entrypoints: { server: "src/server.ts", worker: "src/worker.ts" }, defaultEntrypoint: "server", args: ["default"], assetMappings: [{context:"data",from:"settings.json",to:"/repo/settings.json"}] } }, 'console.log(JSON.stringify({role:"server",asset:await Bun.file("/repo/settings.json").json(),args:process.argv.slice(2),arch:process.arch}));');
  await writeFile(join(source, "src/worker.ts"), 'console.log(JSON.stringify({role:"worker",asset:await Bun.file("/repo/settings.json").json(),args:process.argv.slice(2),arch:process.arch}));');
  const image = await build({ path: source, assetContexts: {data: context}, base: "oven/bun@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9", platform: process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64", output: join(root, "layout"), localCache: false, gitMetadata: false, verifyDeterministic: true });
  const store = new BlobStore(image.layout!);
  for (const platform of image.images) {
    const target = `linux/${platform.platform.architecture}`, tag = `bunko.local/assets-${randomUUID()}:test`;
    const archive = join(root, `${platform.platform.architecture}.tar`);
    await exportDockerArchive(store, platform.manifest, archive, tag, 0);
    await loadArchive(archive, tag); tags.push(tag);
    const args = ["docker", "run", "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--platform", target, tag];
    const server = JSON.parse(await command(args));
    if (server.asset.message !== "external-asset") throw new Error("Default entry could not read mapped asset");
    const worker = JSON.parse(await command([...args, platform.entrypoints!.worker!, "override"]));
    if (worker.asset.message !== "external-asset") throw new Error("Worker could not read mapped asset");
    if (server.role !== "server" || server.args.join() !== "default" || worker.role !== "worker" || worker.args.join() !== "override") throw new Error("Named entrypoint command contract failed");
    const architecture = platform.platform.architecture === "amd64" ? "x64" : "arm64";
    if (server.arch !== architecture || worker.arch !== architecture) throw new Error("Wrong runtime architecture");
    console.log(`PASS: ${target} mapped asset read by default server and overridden worker`);
  }
} finally {
  for (const tag of tags) await command(["docker", "image", "rm", tag]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
