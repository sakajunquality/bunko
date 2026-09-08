/** Execute default and overridden commands from the same image on Linux. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { exportDockerArchive, loadArchive } from "../packages/oci/archive.ts";
import { project } from "./helpers.ts";
import { command } from "./command.ts";

const root = await mkdtemp(join(tmpdir(), "bunko-multiple-")), tags: string[] = [];
try {
  const source = await project(join(root, "app"), { bunko: { entrypoints: { server: "src/server.ts", worker: "src/worker.ts" }, defaultEntrypoint: "server", args: ["default"] } }, 'console.log(JSON.stringify({role:"server",args:process.argv.slice(2),arch:process.arch}));');
  await writeFile(join(source, "src/worker.ts"), 'console.log(JSON.stringify({role:"worker",args:process.argv.slice(2),arch:process.arch}));');
  const image = await build({ path: source, base: "oven/bun@sha256:478281fdd196871c7e51ba6a820b7803a8ae97042ec86cdbc2e1c6b6626442d9", platform: process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64", output: join(root, "layout"), localCache: false, gitMetadata: false, verifyDeterministic: true });
  const store = new BlobStore(image.layout!);
  for (const platform of image.images) {
    const target = `linux/${platform.platform.architecture}`, tag = `bunko.local/multiple-${randomUUID()}:test`;
    const archive = join(root, `${platform.platform.architecture}.tar`);
    await exportDockerArchive(store, platform.manifest, archive, tag, 0);
    await loadArchive(archive, tag); tags.push(tag);
    const args = ["docker", "run", "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--platform", target, tag];
    const server = JSON.parse(await command(args));
    const worker = JSON.parse(await command([...args, platform.entrypoints!.worker!, "override"]));
    if (server.role !== "server" || server.args.join() !== "default" || worker.role !== "worker" || worker.args.join() !== "override") throw new Error("Named entrypoint command contract failed");
    const architecture = platform.platform.architecture === "amd64" ? "x64" : "arm64";
    if (server.arch !== architecture || worker.arch !== architecture) throw new Error("Wrong runtime architecture");
    console.log(`PASS: ${target} default server and overridden worker command`);
  }
} finally {
  for (const tag of tags) await command(["docker", "image", "rm", tag]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
