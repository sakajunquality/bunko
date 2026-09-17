/** Regenerate compatibility fixtures with immutable released writer source.
 * Run from the repository root; --write deliberately replaces checked-in fixtures. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const destination = resolve("test/fixtures/compat");
const writers = await Bun.file(join(destination, "writers.json")).json() as { version: string; commit: string; writerFiles: Record<string, string> }[];
const temporary = await mkdtemp(join(tmpdir(), "bunko-format-writers-"));
async function git(args: string[]) {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`Cannot read recorded writer source: ${err}`);
  return out;
}
async function output(version: string, name: string, value: unknown) {
  const file = join(destination, version, name), text = JSON.stringify(value, null, 2) + "\n";
  if (process.argv.includes("--write")) { await mkdir(join(destination, version), { recursive: true }); await writeFile(file, text); }
  else if (await readFile(file, "utf8") !== text) throw new Error(`Released writer fixture differs: ${version}/${name}`);
}
try {
  for (const writer of writers) {
    const source = join(temporary, writer.version);
    for (const [name, blob] of Object.entries(writer.writerFiles)) {
      if ((await git(["rev-parse", `${writer.commit}:${name}`])).trim() !== blob) throw new Error("Recorded writer source identity mismatch");
      const file = join(source, name); await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, await git(["show", `${writer.commit}:${name}`]));
    }
    const module = (name: string) => import(pathToFileURL(join(source, name)).href);
    const { sha256 } = await module("packages/oci/digest.ts");
    const { imageConfig } = await module("packages/oci/image.ts");
    const { rebaseMetadata } = await module("packages/oci/rebase-metadata.ts");
    const descriptor = (name: string, mediaType = "application/vnd.oci.image.layer.v1.tar") => ({ mediaType, digest: sha256(name), size: name.length });
    const base = {
      descriptor: descriptor("base-manifest", "application/vnd.oci.image.manifest.v1+json"),
      manifest: { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: descriptor("base-config", "application/vnd.oci.image.config.v1+json"), layers: [descriptor("base-layer")] },
      config: { os: "linux", architecture: "amd64", rootfs: { type: "layers", diff_ids: [sha256("base-layer")] }, config: { Env: ["BASE=retained"], User: "1000:1000", Entrypoint: ["/bun"], Cmd: [], WorkingDir: "/", Labels: { example: "base" } } },
    };
    const layers = [{ kind: "app", descriptor: descriptor("app-layer"), diffId: sha256("app-layer") }];
    const options = { platform: { os: "linux", architecture: "amd64" }, epoch: 0, entrypoint: ["/bun"], args: ["/app/index.js"], workdir: "/app", env: { APP: "value" }, labels: { "org.bunko.mode": "bundle", "org.bunko.runtime.libc": "glibc", "org.bunko.bun.version": "1.3.13", "org.bunko.bun.revision": "bf2e2cecf" } };
    const context = { mode: "bundle", libc: "glibc", bunVersion: "1.3.13", bunRevision: "bf2e2cecf", runtimeOrigin: "base" };
    const config = imageConfig(base.config, layers, options);
    config.config.Labels["org.bunko.rebase.metadata"] = rebaseMetadata(base, layers, options, context);
    const image = { descriptor: descriptor("image-manifest", "application/vnd.oci.image.manifest.v1+json"), manifest: { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: descriptor("image-config", "application/vnd.oci.image.config.v1+json"), layers: [...base.manifest.layers, layers[0]!.descriptor] }, config };
    await output(writer.version, "rebase.json", { base, image });
    if (writer.version !== "0.8.0") {
      const nodeOptions = { ...options, runtimeKind: "node", entrypoint: ["/node"], labels: { ...options.labels, "org.bunko.runtime.kind": "node", "org.bunko.node.version": "24" } };
      const nodeConfig = imageConfig(base.config, layers, nodeOptions);
      nodeConfig.config.Labels["org.bunko.rebase.metadata"] = rebaseMetadata(base, layers, nodeOptions, { ...context, runtimeKind: "node" });
      await output(writer.version, "rebase-node.json", { base, image: { ...image, config: nodeConfig } });
      const { buildEvidence, evidenceComment } = await module("packages/bunko/sbom-evidence.ts");
      const inventories = { inventory: [{ name: "runtime-package", version: "1.0.0" }], bundledInventory: [{ name: "bundled-package", version: "2.0.0" }] };
      const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
      const lock = { packages: { declared: ["declared-package@3.0.0", "", {}, integrity] } };
      await output(writer.version, "evidence.json", { included: ["runtime-package@1.0.0", "bundled-package@2.0.0"], comment: evidenceComment(buildEvidence(inventories, lock)) });
      if (writer.version === "0.11.0") {
        const packages = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`declared-${i}`, [`declared-package-${i}@3.0.0`, "", {}, integrity]]));
        await output(writer.version, "evidence-degraded.json", { included: ["runtime-package@1.0.0", "bundled-package@2.0.0"], comment: evidenceComment(buildEvidence(inventories, { packages })) });
      }
    }
  }
  const matrix = [];
  for (const reader of writers.filter((item) => item.version !== "0.8.0")) {
    const { readEvidence } = await import(pathToFileURL(join(temporary, reader.version, "packages/bunko/sbom-evidence.ts")).href);
    for (const writer of writers.filter((item) => item.version !== "0.8.0")) {
      for (const name of writer.version === "0.11.0" ? ["evidence.json", "evidence-degraded.json"] : ["evidence.json"]) {
        const fixture = await Bun.file(join(destination, writer.version, name)).json();
        let accepted = false;
        try { readEvidence(fixture.comment, new Set(fixture.included)); accepted = true; } catch { /* A released reader may reject a newer evidence revision. */ }
        matrix.push({ reader: reader.version, writer: writer.version, fixture: name, accepted });
      }
    }
  }
  await output(".", "evidence-readers.json", matrix);
  console.log("Released format fixtures and evidence rollback matrix verified.");
} finally { await rm(temporary, { recursive: true, force: true }); }
