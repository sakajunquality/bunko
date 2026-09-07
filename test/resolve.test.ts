import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseAllDocuments } from "yaml";
import { parseInput, renderInputs, resolveDocuments } from "../packages/bunko/resolve.ts";
import { MockRegistry } from "./mock-registry.ts";
import { baseLayout, cli, project, temporary } from "./helpers.ts";
import { workspaceFixture } from "./workspace-fixture.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await temporary(); directories.push(root);
  const source = await project(join(root, "app")), base = await baseLayout(join(root, "base"));
  const registry = new MockRegistry();
  const options = { context: root, files: ["-"], baseLayout: base, repo: "registry.test/team", localCache: false, registryCache: false, gitMetadata: false, registry: { fetcher: registry.fetch, credentials: async () => undefined } };
  return { root, source, registry, options };
}
const image = `registry.test/team/app@sha256:${"a".repeat(64)}`;

test("replaces complete values while preserving multi-doc comments, anchors, aliases, keys and numeric bytes", () => {
  const source = '# bunko://comment\nimage: &image bunko://app # keep\ncopy: *image\nbunko://key: unchanged\ntext: "use bunko://app here"\ntemplate: "bunko://${APP}"\ninteger: 9007199254740993\n---\nimage: \'bunko://app\'\n';
  const input = parseInput("test.yaml", source);
  expect(input.replacements).toHaveLength(2);
  const output = renderInputs([input], new Map([["bunko://app", image]]));
  expect(output).toBe(source.replace('image: &image bunko://app', `image: &image "${image}"`).replace("'bunko://app'", `"${image}"`));
  const docs = parseAllDocuments(output);
  expect(docs).toHaveLength(2);
  expect(docs[0]!.toJS().copy).toBe(image);
});

test("handles stripped block scalars, CRLF, complex keys, and anchors declared in keys", () => {
  const source = 'image: |- # retained header\r\n  bunko://app\r\nnext: yes\r\n? [bunko://key, {nested: bunko://key}]\r\n: bunko://app\r\n? &key bunko://app\r\n: literal\r\nimageFromKey: *key\r\n';
  const input = parseInput("test.yaml", source);
  expect(input.replacements).toHaveLength(3);
  const output = renderInputs([input], new Map([["bunko://app", image]]));
  const doc = parseAllDocuments(output)[0]!;
  expect(doc.errors).toHaveLength(0);
  expect(doc.get("image")).toBe(image);
  expect(output).toContain(`"${image}" # retained header\r\n`);
  expect(doc.get("next")).toBe("yes");
  expect(doc.get("imageFromKey")).toBe(image);
  expect(output).toContain("? &key bunko://app");
});

test.each(["|", "|+", ">", ">+"])("rejects retained newlines in %s bunko block scalars", (style) => {
  expect(() => parseInput("block.yaml", `image: ${style}\n  bunko://app\n`)).toThrow("Invalid bunko reference");
});

test.each(["|-", ">-"])("resolves %s bunko block scalars without trimming their values", (style) => {
  const input = parseInput("block.yaml", `image: ${style} # keep\n  bunko://app\n`);
  expect(input.replacements).toHaveLength(1);
  const output = renderInputs([input], new Map([["bunko://app", image]]));
  expect(parseAllDocuments(output)[0]!.get("image")).toBe(image);
  expect(output).toContain("# keep");
  expect(() => parseInput("block.yaml", `image: ${style}\n  bunko://app \n`)).toThrow("Invalid bunko reference");
});

test("rejects invalid syntax, duplicate keys, invalid references and unresolved aliases", () => {
  expect(() => parseInput("bad.yaml", "image: [\n")).toThrow();
  expect(() => parseInput("bad.yaml", "image: one\nimage: two\n")).toThrow();
  expect(() => parseInput("bad.json", '{"image":}')).toThrow("Invalid JSON");
  expect(() => parseInput("bad.yaml", "image: bunko://\n")).toThrow("Invalid bunko reference");
  expect(() => parseInput("bad.yaml", "image: *missing\n")).toThrow("unresolved YAML alias");
  expect(() => parseInput("bad.yaml", "image: &a bunko://app\n*a : key\n")).toThrow("mapping key");
});

test("single JSON remains JSON, multiple JSON becomes an array, mixed inputs form a YAML stream", () => {
  const one = parseInput("a.json", '{"image":"bunko://app","large":9007199254740993}');
  const two = parseInput("b.json", '{"nested":["bunko://app"]}');
  const refs = new Map([["bunko://app", image]]);
  expect(JSON.parse(renderInputs([one], refs)).image).toBe(image);
  expect(renderInputs([one], refs)).toContain("9007199254740993");
  expect(JSON.parse(renderInputs([one, two], refs))).toHaveLength(2);
  const output = renderInputs([one, parseInput("b.yaml", "image: bunko://app\n")], refs);
  expect(parseAllDocuments(output).map((doc) => doc.toJS().image)).toEqual([image, image]);
});

test("joining streams preserves explicit ends, directives and comment-only inputs without adding documents", () => {
  const inputs = [parseInput("empty.yaml", "# before\n"), parseInput("a.yaml", "%YAML 1.1\n---\nboolean: yes\n...\n"), parseInput("comment.yaml", "# between\n"), parseInput("b.yaml", "boolean: yes\n")];
  const output = renderInputs(inputs, new Map());
  const docs = parseAllDocuments(output);
  expect(docs).toHaveLength(2);
  expect(docs.map((d) => d.toJS().boolean)).toEqual([true, "yes"]);
  expect(output).toContain("# between");
  expect(() => parseInput("key.yaml", "? &key {image: bunko://app}\n: value\ncopy: *key\n")).toThrow("anchored in mapping keys");
  expect(() => parseInput("key.yaml", "image: &a bunko://app\ncontainer: &b { image: *a }\n? *b\n: value\n")).toThrow("mapping key");
});

test("canonical references build once; output matches the published immutable reference", async () => {
  const f = await fixture();
  await symlink(f.source, join(f.root, "alias"));
  const report = join(f.root, "report.json");
  const result = await resolveDocuments({ ...f.options, report, stdin: async () => "image: &app bunko://app\ncopy: *app\nother: bunko://alias\n" });
  expect(result.targets).toHaveLength(1);
  const published = result.targets[0]!.publication!.reference;
  expect(parseAllDocuments(result.output)[0]!.toJS()).toEqual({ image: published, copy: published, other: published });
  expect(f.registry.requests.filter((r) => r.method === "PUT" && r.url.pathname.endsWith("/manifests/latest"))).toHaveLength(1);
  const data = JSON.parse(await readFile(report, "utf8"));
  expect(data).toMatchObject({ schemaVersion: 4, command: "resolve", status: "success" });
  expect(data.references["bunko://alias"]).toBe(published);
});

test("groups workspace references for sharedDeps and rejects ambiguous roots", async () => {
  const f = await fixture(), w = await workspaceFixture(join(f.root, "fixtures"));
  const options = { ...f.options, context: w.source, installCache: w.cache, sharedDeps: true };
  await expect(resolveDocuments({ ...options, stdin: async () => "image: bunko://.\n" })).rejects.toThrow("multiple targets");
  const result = await resolveDocuments({ ...options, stdin: async () => "images: [bunko://services/api, bunko://services/worker, bunko://services/api]\n" });
  expect(result.targets).toHaveLength(2);
  expect(result.targets[0]!.layers[0]!.descriptor.digest).toBe(result.targets[1]!.layers[0]!.descriptor.digest);
  const report = join(f.root, "partial-workspace.json");
  await expect(resolveDocuments({ ...options, report, stdin: async () => "images: [bunko://services/api, bunko://services/worker]\n", registry: { credentials: async () => undefined, fetcher: (url, init) => {
    if (init?.method === "PUT" && new URL(url).pathname.endsWith("/fixture-worker/manifests/latest")) return Promise.resolve(new Response(null, { status: 403 }));
    return f.registry.fetch(url, init);
  } } })).rejects.toThrow("403");
  expect(JSON.parse(await readFile(report, "utf8")).pendingTargets).toEqual([await realpath(join(w.source, "services/worker"))]);
  expect(parseAllDocuments(result.output)[0]!.toJS().images).toEqual([result.targets[0]!.publication!.reference, result.targets[1]!.publication!.reference, result.targets[0]!.publication!.reference]);
});

test("directory inputs are sorted, nonrecursive by default, and repeat files are deduplicated", async () => {
  const f = await fixture(), input = join(f.root, "manifests");
  await mkdir(join(input, "nested"), { recursive: true });
  await writeFile(join(input, "z.yaml"), "value: z\n");
  await writeFile(join(input, "a.json"), '{"value":"a"}');
  await writeFile(join(input, "ignored.txt"), "not YAML [");
  await writeFile(join(input, "nested/b.yml"), "value: b\n");
  const read = async (recursive: boolean) => (await resolveDocuments({ ...f.options, files: [input, join(input, "z.yaml")], recursive })).output;
  expect(parseAllDocuments(await read(false)).map((d) => d.toJS().value)).toEqual(["a", "z"]);
  expect(parseAllDocuments(await read(true)).map((d) => d.toJS().value)).toEqual(["a", "b", "z"]);
  expect(f.registry.requests).toHaveLength(0);
});

test("all contexts build before publication; later compile failure writes a partial report without registry writes", async () => {
  const f = await fixture();
  await project(join(f.root, "later"), { name: "later" }, 'import "missing-package";');
  const report = join(f.root, "failed.json");
  await expect(resolveDocuments({ ...f.options, report, stdin: async () => "images: [bunko://app, bunko://later]\n" })).rejects.toThrow("Bun build failed");
  expect(f.registry.requests.every((r) => ["GET", "HEAD"].includes(r.method))).toBe(true);
  const data = JSON.parse(await readFile(report, "utf8"));
  expect(data.status).toBe("failed");
  expect(data.targets).toHaveLength(1);
  expect(data.pendingTargets).toEqual([await realpath(f.source), await realpath(join(f.root, "later"))]);
});

test("target identity changes during preparation cannot misroute another image reference", async () => {
  const f = await fixture();
  const later = await project(join(f.root, "later"), { name: "later" });
  let changed = false;
  await expect(resolveDocuments({ ...f.options, stdin: async () => "images: [bunko://app, bunko://later]\n", log: (message) => {
    if (!changed && message.startsWith("Bundling")) {
      changed = true;
      writeFileSync(join(later, "package.json"), JSON.stringify({ name: "hello", module: "src/server.ts" }));
    }
  } })).rejects.toThrow("Target identity changed");
  expect(f.registry.requests.every((r) => ["GET", "HEAD"].includes(r.method))).toBe(true);
});

test("syntax and image name collisions fail before registry access; existing reports are preserved", async () => {
  const f = await fixture();
  await project(join(f.root, "other"));
  await expect(resolveDocuments({ ...f.options, stdin: async () => "images: [bunko://app, bunko://other]\n" })).rejects.toThrow("name collision");
  await expect(resolveDocuments({ ...f.options, stdin: async () => "image: bunko://app\n---\ninvalid: [" })).rejects.toThrow();
  const report = join(f.root, "report.json"); await writeFile(report, "keep");
  await expect(resolveDocuments({ ...f.options, report, stdin: async () => "image: bunko://app\n" })).rejects.toThrow();
  expect(await readFile(report, "utf8")).toBe("keep");
  expect(f.registry.requests).toHaveLength(0);
});

test("CLI rejects ambiguous modes and leaves stdout empty on input/build errors", async () => {
  const f = await fixture(), file = join(f.root, "bad.yaml");
  await writeFile(file, "image: [\n");
  const failed = await cli(["resolve", "-f", file, "--repo", "registry.test/team"]);
  expect(failed.exit).toBe(1); expect(failed.stdout).toBe("");
  expect((await cli(["resolve", "-f", file, "--dry-run"])).stderr).toContain("requires Registry publication");
  expect((await cli(["build", "-f", file])).stderr).toContain("not supported by build");
});

test("CLI stdin success prints only documents, and partial publication failure prints no stdout", async () => {
  const f = await fixture();
  await project(join(f.root, "later"), { name: "later" });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    if (request.method === "PUT" && new URL(request.url).pathname.endsWith("/later/manifests/latest")) return new Response(null, { status: 403 });
    return f.registry.fetch(request.url, { method: request.method, headers: request.headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() });
  } });
  const host = `127.0.0.1:${server.port}`, config = join(f.root, "docker.json");
  await writeFile(config, "{}");
  const run = async (input: string, report: string) => {
    const child = Bun.spawn([process.execPath, resolve("packages/bunko/cli.ts"), "resolve", "-f", "-", "--context", f.root, "--repo", `${host}/team`, "--insecure-registry", host, "--base-layout", f.options.baseLayout, "--report", report, "--no-cache", "--git-metadata=false"], { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", env: { ...process.env, BUNKO_DOCKER_CONFIG: config } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  };
  try {
    const success = await run('image: bunko://app\n', join(f.root, "success.json"));
    expect(success.exit).toBe(0);
    expect(parseAllDocuments(success.stdout)[0]!.toJS().image).toMatch(new RegExp(`^${host}/team/hello@sha256:`));
    const failedReport = join(f.root, "failed.json");
    const failed = await run('images: [bunko://app, bunko://later]\n', failedReport);
    expect(failed.exit).toBe(1); expect(failed.stdout).toBe(""); expect(failed.stderr).toContain("403");
    const report = JSON.parse(await readFile(failedReport, "utf8"));
    expect(report.status).toBe("failed");
    expect(report.targets[0].publication.tags).toEqual(["latest"]);
    expect(report.targets[1].publication.pendingTags).toEqual(["latest"]);
    expect(report.pendingTargets).toEqual([await realpath(join(f.root, "later"))]);
  } finally { await server.stop(true); }
});
