import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build as rawBuild, writeReport } from "../packages/bunko/build.ts";
import { VERSION, epoch, loadProject } from "../packages/bunko/config.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { media, type Descriptor, type ImageConfig, type ImageIndex, type ImageManifest } from "../packages/oci/types.ts";
import { baseLayout, cli, inspectTar, project, readJSON, temporary } from "./helpers.ts";

const build: typeof rawBuild = (options) => rawBuild({ localCache: false, registryCache: false, ...options });

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function setup() {
  const root = await temporary(); directories.push(root);
  const base = await baseLayout(join(root, "base"));
  return { root, base };
}

async function verifyLayout(root: string) {
  const index: ImageIndex = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
  expect(JSON.parse(await readFile(join(root, "oci-layout"), "utf8"))).toEqual({ imageLayoutVersion: "1.0.0" });
  const visited = new Set<string>();
  async function verify(d: Descriptor) {
    if (visited.has(d.digest)) return;
    visited.add(d.digest);
    const bytes = await readFile(new BlobStore(root).path(d.digest));
    expect(bytes.length).toBe(d.size);
    expect(sha256(bytes)).toBe(d.digest);
    if (d.mediaType === media.index) for (const child of (JSON.parse(bytes.toString()) as ImageIndex).manifests) await verify(child);
    if (d.mediaType === media.manifest) {
      const manifest: ImageManifest = JSON.parse(bytes.toString());
      await verify(manifest.config);
      for (const layer of manifest.layers) await verify(layer);
    }
  }
  for (const d of index.manifests) await verify(d);
}

describe("Bun to OCI layout", () => {
  test("builds a complete deterministic layout, preserves the base, and runs the emitted JS", async () => {
    const { root, base } = await setup();
    const source = await project(join(root, "app"));
    const result = await build({ path: source, baseLayout: base, output: join(root, "out"), gitMetadata: false, verifyDeterministic: true, report: join(root, "result.json") });
    expect(result.verifiedDeterministic).toBe(true);
    expect(result.root.mediaType).toBe(media.index);
    expect(result.layers.map((layer) => layer.kind)).toEqual(["app"]);
    await verifyLayout(result.layout!);
    const config = await readJSON<ImageConfig>(result.layout!, result.config);
    expect(config.rootfs.diff_ids).toHaveLength(2);
    expect(config.config?.Env).toContain("BASE_FLAG=retained");
    expect(config.config?.Cmd).toEqual([]);
    expect(config.config?.Entrypoint).toEqual(["/usr/local/bin/bun", "/app/src/server.js"]);
    const files = await inspectTar(new BlobStore(result.layout!).path(result.layers[0]!.descriptor.digest));
    const application = files.find((file) => file.name === "app/src/server.js")!;
    await writeFile(join(root, "server.js"), application.content!);
    const child = Bun.spawn([process.execPath, join(root, "server.js")], { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(child.stdout).text()).toBe("hello bunko\n");
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await readFile(join(root, "result.json"), "utf8")).root.digest).toBe(result.root.digest);
    expect((await readdir(source)).sort()).toEqual(["package.json", "src"]);
  });

  test("different checkout depths produce identical image and sourcemap digests", async () => {
    const { root, base } = await setup();
    const first = await project(join(root, "a"), { bunko: { build: { sourcemap: "external" } } }, 'console.log(import.meta.url, "stable");\n');
    const second = join(root, "deeper", "b");
    await cp(first, second, { recursive: true });
    const a = await build({ path: first, baseLayout: base, output: join(root, "out-a"), gitMetadata: false });
    const b = await build({ path: second, baseLayout: base, output: join(root, "out-b"), gitMetadata: false });
    expect(a.root.digest).toBe(b.root.digest);
    const files = await inspectTar(new BlobStore(a.layout!).path(a.layers[0]!.descriptor.digest));
    const maps = files.filter((file) => file.name.endsWith(".map"));
    expect(maps).toHaveLength(1);
    expect(maps[0]!.content).not.toContain(root);
    expect(JSON.parse(maps[0]!.content!).sources).toEqual(["bunko:///src/server.ts"]);
  });

  test("source changes only alter the app layer while assets retain their digest", async () => {
    const { root, base } = await setup();
    const source = await project(join(root, "app"), { bunko: { assets: ["public"], workdir: "/srv/service", env: { ANSWER: "42" }, args: ["argument"] } });
    await mkdir(join(source, "public"));
    await writeFile(join(source, "public", "message.txt"), "static\n");
    const a = await build({ path: source, baseLayout: base, output: join(root, "out-a"), gitMetadata: false });
    await writeFile(join(source, "src/server.ts"), 'console.log("changed");\n');
    const b = await build({ path: source, baseLayout: base, output: join(root, "out-b"), gitMetadata: false });
    expect(a.layers.map((layer) => layer.kind)).toEqual(["assets", "app"]);
    expect(a.layers[0]!.descriptor.digest).toBe(b.layers[0]!.descriptor.digest);
    expect(a.layers[1]!.descriptor.digest).not.toBe(b.layers[1]!.descriptor.digest);
    const assets = await inspectTar(new BlobStore(a.layout!).path(a.layers[0]!.descriptor.digest));
    expect(assets.find((file) => file.name === "srv/service/public/message.txt")?.content).toBe("static\n");
    const config = await readJSON<ImageConfig>(a.layout!, a.config);
    expect(config.config?.WorkingDir).toBe("/srv/service");
    expect(config.config?.Cmd).toEqual(["argument"]);
    expect(config.config?.Env).toContain("ANSWER=42");
  });

  test("HTML imports retain the server entry, HTML, and browser outputs", async () => {
    const { root, base } = await setup();
    const source = await project(join(root, "app"), {}, 'import page from "../index.html"; Bun.serve({ routes: {"/": page} });\n');
    await writeFile(join(source, "index.html"), '<!doctype html><script type="module" src="./client.ts"></script><h1>hello</h1>');
    await writeFile(join(source, "client.ts"), 'console.log("browser");\n');
    const result = await build({ path: source, baseLayout: base, output: join(root, "out"), gitMetadata: false, verifyDeterministic: true });
    const files = await inspectTar(new BlobStore(result.layout!).path(result.layers[0]!.descriptor.digest));
    expect(files.some((file) => file.name === "app/src/server.js")).toBe(true);
    expect(files.some((file) => file.name === "app/index.html")).toBe(true);
    expect(files.filter((file) => file.name.endsWith(".js")).length).toBeGreaterThan(1);
  });

  test("CLI keeps stdout empty for local output and returns useful failures", async () => {
    const { root, base } = await setup();
    const source = await project(join(root, "app"));
    const ok = await cli(["build", source, "--push=false", "--base-layout", base, "--oci-layout", join(root, "out"), "--no-index"]);
    expect(ok.exit).toBe(0);
    expect(ok.stdout).toBe("");
    expect(ok.stderr).toContain("OCI layout:");
    const index: ImageIndex = JSON.parse(await readFile(join(root, "out/index.json"), "utf8"));
    expect(index.manifests[0]!.mediaType).toBe(media.manifest);
    expect((await cli(["build", source])).stderr).toContain("Registry push requires --repo");
    expect((await cli(["build", source, "--unknown"])).exit).toBe(1);
    expect((await cli(["version"])).stdout).toBe(`${VERSION}\n`);
  });

  test("does not overwrite existing output, and replaces only regular report files", async () => {
    const { root, base } = await setup();
    const source = await project(join(root, "app"));
    const output = join(root, "out");
    await mkdir(output);
    await writeFile(join(output, "keep"), "keep");
    await expect(build({ path: source, baseLayout: base, output })).rejects.toThrow("already exists");
    expect(await readFile(join(output, "keep"), "utf8")).toBe("keep");
    // A previous run's report is replaced atomically, so local iteration and CI re-runs need no cleanup.
    const report = join(root, "report.json");
    await writeFile(report, JSON.stringify({ schemaVersion: 3, status: "failed", targets: [] }));
    const result = await build({ path: source, baseLayout: base, output: join(root, "new"), report });
    expect(JSON.parse(await readFile(report, "utf8")).root.digest).toBe(result.root.digest);
    // Anything that is not a regular file is refused before the build starts, and never written through.
    const directory = join(root, "report-dir"), link = join(root, "report-link");
    await mkdir(directory);
    await symlink(report, link);
    for (const path of [directory, link]) await expect(build({ path: source, baseLayout: base, output: join(root, "unused"), report: path })).rejects.toThrow("Report path is not a regular file");
    expect((await readdir(directory)).length).toBe(0);
    expect(JSON.parse(await readFile(report, "utf8")).root.digest).toBe(result.root.digest);
  });

  test("writeReport replaces regular files atomically and refuses other entries", async () => {
    const root = await temporary(); directories.push(root);
    const report = join(root, "nested", "report.json");
    await writeReport(report, { schemaVersion: 3, status: "success", targets: [], first: true });
    await writeReport(report, { schemaVersion: 3, status: "success", targets: [], second: true });
    expect(JSON.parse(await readFile(report, "utf8"))).toEqual({ schemaVersion: 3, status: "success", targets: [], second: true });
    expect((await readdir(join(root, "nested"))).sort()).toEqual(["report.json"]);
    await mkdir(join(root, "dir"));
    await symlink(report, join(root, "link"));
    await writeFile(join(root, "target"), "keep");
    await symlink(join(root, "target"), join(root, "target-link"));
    for (const path of [join(root, "dir"), join(root, "link"), join(root, "target-link")]) await expect(writeReport(path, {})).rejects.toThrow("Report path is not a regular file");
    expect(await readFile(join(root, "target"), "utf8")).toBe("keep");
    expect(JSON.parse(await readFile(report, "utf8"))).toEqual({ schemaVersion: 3, status: "success", targets: [], second: true });
    // Reports written by this invocation are recorded so a failure handler can leave them in place.
    const written = new Set<string>();
    await writeReport(report, { schemaVersion: 3, status: "success", targets: [], third: true }, written);
    expect(written.has(report)).toBe(true);
  });

  test("fails before output on unsupported dependencies, macros, and source symlinks", async () => {
    const { root, base } = await setup();
    const source = await project(join(root, "app"), { dependencies: { hono: "4.0.0" } });
    const options = { path: source, baseLayout: base, output: join(root, "out") };
    await expect(build(options)).rejects.toThrow("text bun.lock");
    await project(source, {}, 'import { value } from "./macro.ts" with /* comment */ { type: "macro" }; console.log(value());\n');
    await expect(build(options)).rejects.toThrow("macros are not supported");
    await project(source);
    await symlink("/etc/passwd", join(source, "link"));
    await expect(build(options)).rejects.toThrow("symlinks are not supported");
    expect(await Bun.file(join(options.output, "index.json")).exists()).toBe(false);
  });

  test("rejects assets that overlap the app output", async () => {
    const { root, base } = await setup();
    const source = await project(join(root, "app"), { bunko: { assets: ["src/server.js"] } });
    await writeFile(join(source, "src/server.js"), "collision\n");
    await expect(build({ path: source, baseLayout: base, output: join(root, "out") })).rejects.toThrow("overlap");
  });

  test("output aliases and empty destination directories do not enter the source snapshot", async () => {
    const { root, base } = await setup();
    const source = await project(join(root, "app"), {}, 'import {join} from "path"; console.log(join("a", "b"));\n');
    const a = await build({ path: source, baseLayout: base, output: join(root, "first"), gitMetadata: false });
    await mkdir(join(source, "output"));
    await symlink(source, join(root, "alias"));
    const b = await build({ path: join(root, "alias"), baseLayout: base, output: join(root, "alias/output"), gitMetadata: false });
    expect(a.sourceDigest).toBe(b.sourceDigest);
    expect(a.root.digest).toBe(b.root.digest);
  });

  test("unresolved imports and mutable bases in reproducible mode are failures", async () => {
    const { root, base } = await setup();
    const source = await project(join(root, "app"), {}, 'import missing from "missing-package"; console.log(missing);\n');
    await expect(build({ path: source, baseLayout: base, output: join(root, "out") })).rejects.toThrow("Bun build failed");
    await expect(build({ path: source, base: "oven/bun:latest", output: join(root, "out"), reproducible: true })).rejects.toThrow("sha256 digest");
  });

  test("rejects absolute imports outside the source snapshot", async () => {
    const { root, base } = await setup();
    const external = join(root, "outside.ts");
    await writeFile(external, 'export default "outside";\n');
    const source = await project(join(root, "app"), {}, `import value from ${JSON.stringify(external)}; console.log(value);\n`);
    await expect(build({ path: source, baseLayout: base, output: join(root, "out") })).rejects.toThrow("escaped the project snapshot");
  });

  test("rejects tsconfig inheritance outside the source snapshot", async () => {
    const { root, base } = await setup();
    const source = await project(join(root, "app"));
    await writeFile(join(source, "tsconfig.json"), '{"extends":"../outside.json"}');
    await expect(build({ path: source, baseLayout: base, output: join(root, "out") })).rejects.toThrow("inside the project snapshot");
  });
});

describe("configuration", () => {
  test.each(["-1", "abc", "1.5", "01", "253402300800"])("rejects invalid SOURCE_DATE_EPOCH %s", (value) => expect(() => epoch(value)).toThrow());
  test("supports epoch zero", () => expect(epoch("0")).toBe(0));
  test("does not fall back from a broken declared entrypoint", async () => {
    const { root } = await setup();
    const source = await project(join(root, "app"), { module: "missing.ts" });
    await writeFile(join(source, "index.ts"), "console.log(1)");
    await expect(loadProject({ path: source, output: join(root, "out") })).rejects.toThrow();
  });
});


test("report replacement preserves manifest, source, config, and layout inputs", async () => {
  const root = await temporary(); directories.push(root);
  const source = await project(join(root, "source")), base = await baseLayout(join(root, "base"));
  const config = join(source, "settings.json"); await writeFile(config, JSON.stringify({ setting: true }));
  for (const report of [join(source, "package.json"), join(source, "src/server.ts"), config, join(base, "index.json")]) {
    const before = await readFile(report, "utf8");
    await expect(build({ path: source, baseLayout: base, output: join(root, "out"), report, localCache: false, gitMetadata: false })).rejects.toThrow("does not contain a Bunko report");
    expect(await readFile(report, "utf8")).toBe(before);
  }
  const report = join(source, "report.json");
  const result = await build({ path: source, baseLayout: base, output: join(root, "first"), report, localCache: false, gitMetadata: false });
  const repeated = await build({ path: source, baseLayout: base, output: join(root, "second"), report, localCache: false, gitMetadata: false });
  expect(repeated.root.digest).toBe(result.root.digest);
});
