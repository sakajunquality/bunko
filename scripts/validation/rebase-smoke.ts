/** Execute rebased glibc/musl images on both architectures with preserved layers and private CA trust. */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BlobStore } from "../../packages/oci/blob-store.ts";
import { canonicalJSON } from "../../packages/oci/digest.ts";
import { exportLayout } from "../../packages/oci/layout.ts";
import { exportDockerArchive } from "../../packages/oci/archive.ts";
import { packLayer } from "../../packages/oci/tar.ts";
import { LayoutSource, RegistrySource, resolveBase } from "../../packages/oci/source.ts";
import { media, type Platform } from "../../packages/oci/types.ts";
import { prepareBase } from "../../packages/bunko/prepare-base.ts";
import { command } from "../../test/command.ts";

const directory = await mkdtemp(join(tmpdir(), "bunko-rebase-smoke-")), tags: string[] = [], records = [];
const cli = [process.execPath, resolve("dist/bunko.js")];
const platforms = (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",");
try {
  await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "ca.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-addext", "basicConstraints=critical,CA:TRUE"]);
  await chmod(join(directory, "key.pem"), 0o644);
  for (const libc of ["glibc", "musl"] as const) {
    const source = new RegistrySource(`oven/bun:${Bun.version}-${libc === "musl" ? "alpine" : "distroless"}`);
    const pinned = await source.root(), reference = `oven/bun@${pinned.descriptor.digest}`;
    for (const name of platforms) {
      const platform: Platform = { os: "linux", architecture: name.split("/")[1] as Platform["architecture"] };
      const prefix = `${libc}-${platform.architecture}`, oldDirectory = join(directory, `${prefix}-old`), newDirectory = join(directory, `${prefix}-new`);
      console.error(`Preparing ${prefix}: ${reference}`);
      await prepareBase({ base: reference, output: oldDirectory, platform: name });
      const store = new BlobStore(join(directory, `${prefix}-store`));
      const old = await resolveBase(new LayoutSource(oldDirectory), platform, store);
      const extra = (await packLayer(store, [{ path: "etc/bunko-rebase-validation", type: "file", content: Buffer.from("compatible test base extension\n") }], "assets", 0, []))!;
      const config = await store.put(canonicalJSON({ ...old.config, config: { ...old.config.config, Labels: { ...old.config.config?.Labels, "test.rebase": "replacement" } }, rootfs: { type: "layers", diff_ids: [...old.config.rootfs.diff_ids, extra.diffId] }, ...(old.config.history ? { history: [...old.config.history, { created_by: "rebase validation fixture" }] } : {}) }), media.config);
      const manifest = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, config, layers: [...old.manifest.layers, extra.descriptor] }), media.manifest);
      await exportLayout(store, newDirectory, { ...manifest, platform }, [config, ...old.manifest.layers, extra.descriptor], "replacement");
      const policy = join(directory, `${prefix}-policy.json`);
      await writeFile(policy, canonicalJSON({ schemaVersion: 1, transitions: [{ platform: name, libc, oldBase: old.descriptor.digest, newBase: manifest.digest }] }));
      for (const mode of ["bundle", "source", "compile"]) {
        const id = `${prefix}-${mode}`, app = join(directory, `${id}-app`), layout = join(directory, `${id}-original`), output = join(directory, `${id}-rebased`);
        await mkdir(app); await writeFile(join(app, "ca.pem"), await readFile(join(directory, "ca.pem")));
        await writeFile(join(app, "package.json"), canonicalJSON({ name: "rebase-validation", module: "index.ts", type: "module", bunko: { mode, assets: ["ca.pem"], runtime: { libc, caCertificates: ["ca.pem"], ...(libc === "musl" && mode !== "compile" ? { inject: "release", bunPath: "/opt/bunko/bun" } : {}) } } }));
        await writeFile(join(app, "index.ts"), `const server = Bun.serve({hostname:'127.0.0.1',port:0,tls:{key:Bun.file('/run/key.pem'),cert:Bun.file('/app/ca.pem')},fetch:()=>new Response('trusted')});\ntry {const trust=await (await fetch('https://localhost:'+server.port)).text(); console.log(JSON.stringify({version:Bun.version,uid:process.getuid!(),trust}));} finally {server.stop(true);}\n`);
        const report = join(directory, `${id}-build.json`), rebaseReport = join(directory, `${id}-rebase.json`);
        await command([...cli, "build", app, "--base-layout", oldDirectory, "--platform", name, "--oci-layout", layout, "--push=false", "--git-metadata=false", "--sbom", "--provenance", "--report", report]);
        const before = JSON.parse(await readFile(report, "utf8"));
        await rm(app, { recursive: true });
        await command([...cli, "rebase", `layout:${layout}`, "--old-base", `layout:${oldDirectory}`, "--base-layout", newDirectory, "--compatibility-policy", policy, "--oci-layout", output, "--sbom", "--provenance", "--report", rebaseReport]);
        const after = JSON.parse(await readFile(rebaseReport, "utf8"));
        if (JSON.stringify(before.layers.map((layer: any) => layer.descriptor.digest)) !== JSON.stringify(after.platforms[0].preservedLayers)) throw new Error("Rebase changed generated layers");
        const finalStore = new BlobStore(join(directory, `${id}-run`)), final = await resolveBase(new LayoutSource(output), platform, finalStore);
        const tag = `bunko.local/rebase-validation:${randomUUID()}`, archive = join(directory, `${id}.tar`);
        await exportDockerArchive(finalStore, final.descriptor, archive, tag, 0); await command(["docker", "load", "--input", archive]); tags.push(tag);
        const actual = JSON.parse(await command(["docker", "run", "--rm", "--platform", name, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--mount", `type=bind,src=${join(directory, "key.pem")},dst=/run/key.pem,readonly`, tag]));
        if (actual.uid !== 65532 || actual.trust !== "trusted" || actual.version !== Bun.version) throw new Error(`Unexpected rebased runtime: ${JSON.stringify(actual)}`);
        records.push({ libc, platform: name, mode, original: before.root.digest, rebased: after.root.digest, preservedLayers: after.platforms[0].preservedLayers, runtime: actual });
        console.error(`Passed ${id}`);
      }
    }
  }
  console.log(JSON.stringify({ status: "passed", records }, null, 2));
} finally {
  for (const tag of tags) await command(["docker", "image", "rm", tag]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
