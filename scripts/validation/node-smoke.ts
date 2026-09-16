/** Exercise actual Node HTTP and asset reads in nonroot, read-only containers. */
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BlobStore } from "../../packages/oci/blob-store.ts";
import { exportDockerArchive } from "../../packages/oci/archive.ts";
import { command } from "../../test/command.ts";
const root = await mkdtemp(join(tmpdir(), "bunko-node-smoke-")), tags: string[] = [], records = [];
const cli = [process.execPath, resolve("dist/bunko.js")];
try {
  for (const libc of ["glibc", "musl"]) for (const mode of ["bundle", "source"]) for (const platform of (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",")) {
    const id = `${libc}-${mode}-${platform.split("/")[1]}`, app = join(root, id), report = join(root, `${id}.json`), layout = join(root, `${id}-image`);
    await cp(resolve("examples/node-http"), app, { recursive: true });
    const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8")); manifest.bunko.mode = mode; manifest.bunko.runtime.libc = libc; await writeFile(join(app, "package.json"), JSON.stringify(manifest));
    await command([...cli, "build", app, "--platform", platform, "--oci-layout", layout, "--push=false", "--git-metadata=false", "--sbom", "--provenance", "--report", report]);
    const result = JSON.parse(await readFile(report, "utf8")), tag = `bunko.local/node-validation:${randomUUID()}`, archive = join(root, `${id}.tar`);
    await exportDockerArchive(new BlobStore(layout), result.images[0].manifest, archive, tag, 0); await command(["docker", "load", "--input", archive]); tags.push(tag);
    const actual = JSON.parse(await command(["docker", "run", "--rm", "--platform", platform, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=512m", tag, "--self-test"]));
    if (actual.runtime !== "node" || actual.uid !== 65532 || actual.message !== "Hello from Node") throw new Error("Node acceptance failed");
    records.push({ libc, mode, platform, digest: result.root.digest, actual }); console.error(`Passed ${id}`);
  }
  console.log(JSON.stringify({ status: "passed", records }, null, 2));
} finally { for (const tag of tags) await command(["docker", "image", "rm", tag]).catch(() => {}); await rm(root, { recursive: true, force: true }); }
