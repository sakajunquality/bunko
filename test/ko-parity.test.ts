import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { build } from "../packages/bunko/build.ts";
import { resolveDocuments } from "../packages/bunko/resolve.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { labelSelector, selectDocuments } from "../packages/bunko/selector.ts";
import { baseLayout, inspectTar, project, readJSON, temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await temporary(); directories.push(root);
  return { root, source: await project(join(root, "app")), base: await baseLayout(join(root, "base")), remote: new MockRegistry() };
}

test("image metadata overrides are deterministic and annotations reach manifest and index", async () => {
  const f = await fixture(), output = join(f.root, "image");
  await writeFile(join(f.source, "package.json"), JSON.stringify({ name: "app", module: "src/server.ts", bunko: { labels: { team: "old" }, annotations: { note: "old" }, user: "1000" } }));
  const result = await build({ path: f.source, baseLayout: f.base, output, push: false, localCache: false, gitMetadata: false, verifyDeterministic: true,
    imageLabels: { team: "new=team,yes" }, imageAnnotations: { note: "new" }, imageUser: "65532:65532" });
  const config = await readJSON<any>(output, result.config), manifest = await readJSON<any>(output, result.images[0]!.manifest), index = await readJSON<any>(output, result.root);
  expect(config.config.Labels.team).toBe("new=team,yes"); expect(config.config.User).toBe("65532:65532");
  expect(manifest.annotations).toEqual({ note: "new" }); expect(index.annotations).toEqual(manifest.annotations);
  await expect(loadProject({ path: f.source, imageAnnotations: { "org.opencontainers.image.ref.name": "wrong" } })).rejects.toThrow("reserved");
  await expect(loadProject({ path: f.source, imageLabels: { "org.bunko.version": "wrong" } })).rejects.toThrow("reserved");
});

test("image reference files contain successful immutable roots and never overwrite or describe partial failure as success", async () => {
  const f = await fixture(), imageRefs = join(f.root, "refs.txt"), registry = { fetcher: f.remote.fetch, credentials: async () => undefined };
  const options = { path: f.source, baseLayout: f.base, repo: "registry.test/team", localCache: false, registryCache: false, gitMetadata: false, registry };
  const result = await build({ ...options, imageRefs });
  expect(await readFile(imageRefs, "utf8")).toBe(`${result.publication!.reference}\n`);
  f.remote.requests.splice(0);
  await expect(build({ ...options, imageRefs })).rejects.toThrow("exists"); expect(f.remote.requests).toHaveLength(0);
  f.remote.failTag = "fail";
  const failedRefs = join(f.root, "failed.txt"), report = join(f.root, "failed.json");
  await expect(build({ ...options, imageRefs: failedRefs, tags: ["fail"], report })).rejects.toThrow("403");
  expect(await Bun.file(failedRefs).exists()).toBe(false); expect((await Bun.file(report).json()).publication.published).toBe(true);
  await expect(build({ ...options, imageRefs: join(f.root, "overlap"), output: join(f.root, "overlap/image") })).rejects.toThrow("overlap");
});

test("selectors implement equality, existence and sets with Kubernetes missing-label semantics", () => {
  expect(labelSelector("app=api,tier in (backend,worker),!disabled")({ app: "api", tier: "backend" })).toBe(true);
  expect(labelSelector("app!=api")({})).toBe(true); expect(labelSelector("tier notin (backend)")({})).toBe(true);
  expect(labelSelector("app=")({})).toBe(false); expect(labelSelector("app=")({ app: "" })).toBe(true);
  expect(labelSelector("app")({ app: "" })).toBe(true);
  for (const value of ["", "app in ()", "app in (api", "app=api,", "app>api", "bad/key/more=x"]) expect(() => labelSelector(value)).toThrow();
});

test("selection preserves scalar precision and only selected references build", async () => {
  const f = await fixture(), imageRefs = join(f.root, "selected.txt");
  const source = "metadata: {labels: {app: api}}\nnumber: 9007199254740993\nimage: bunko://app\n---\nmetadata: {labels: {app: worker}}\nimage: bunko://missing\n";
  const result = await resolveDocuments({ files: ["-"], stdin: async () => source, selector: "app=api", context: f.root, baseLayout: f.base, repo: "registry.test/team", localCache: false, registryCache: false, gitMetadata: false, imageRefs, registry: { fetcher: f.remote.fetch, credentials: async () => undefined } });
  expect(result.targets).toHaveLength(1); expect(result.output).toContain("9007199254740993"); expect(result.output).not.toContain("worker");
  expect(parseAllDocuments(result.output)[0]!.toJS().image).toBe(result.targets[0]!.publication!.reference);
  expect((await readFile(imageRefs, "utf8")).trim()).toBe(result.targets[0]!.publication!.reference);
  f.remote.requests.splice(0);
  const none = await resolveDocuments({ files: ["-"], stdin: async () => source, selector: "app=none", context: f.root, registry: { fetcher: f.remote.fetch } });
  expect(none.output).toBe(""); expect(none.targets).toHaveLength(0); expect(f.remote.requests).toHaveLength(0);
  expect(selectDocuments("one.json", '{"metadata":{"labels":{"app":"api"}},"n":9007199254740993}', labelSelector("app=api"))).toContain("9007199254740993");
});

test("bunkodata is a conventional asset layer with a reserved runtime path and content invalidation", async () => {
  const f = await fixture(); await mkdir(join(f.source, "bunkodata/nested"), { recursive: true });
  const file = join(f.source, "bunkodata/nested/message.txt"); await writeFile(file, "first");
  const options = { path: f.source, baseLayout: f.base, push: false, gitMetadata: false, cacheDir: join(f.root, "cache") };
  const first = await build({ ...options, output: join(f.root, "one") });
  const config = await readJSON<any>(first.layout!, first.config);
  expect(config.config.Env).toContain("BUNKO_DATA_PATH=/app/bunkodata");
  const asset = first.layers.find((layer) => layer.kind === "assets")!;
  expect((await inspectTar(new BlobStore(first.layout!).path(asset.descriptor.digest))).find((entry) => entry.name === "app/bunkodata/nested/message.txt")!.content).toBe("first");
  await writeFile(file, "second");
  const second = await build({ ...options, output: join(f.root, "two") });
  expect(second.layers.find((layer) => layer.kind === "assets")!.descriptor.digest).not.toBe(asset.descriptor.digest);
  await symlink(join(f.root, "base"), join(f.source, "bunkodata/escape"));
  await expect(build({ ...options, output: join(f.root, "three") })).rejects.toThrow("symlinks");
});

test("selector normalization preserves YAML versions and aliases; empty apply starts no kubectl process", async () => {
  const selected = selectDocuments("stream.yaml", '%YAML 1.1\n---\nmetadata: {labels: {app: old}}\n---\nmetadata: {labels: {app: keep}}\nflag: yes\nvalue: &item 42\ncopy: *item\n', labelSelector("app=keep"))!;
  expect(parseAllDocuments(selected)[0]!.toJS()).toMatchObject({ flag: true, value: 42, copy: 42 });
  const f = await fixture(), kubectl = join(f.root, "kubectl"), marker = join(f.root, "called");
  await writeFile(kubectl, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const { applyDocuments } = await import("../packages/bunko/apply.ts");
  const result = await applyDocuments({ files: ["-"], stdin: async () => "metadata: {labels: {app: ignored}}\nimage: bunko://missing\n", selector: "app=keep", context: f.root, kubectlPath: kubectl });
  expect(result.exit).toBe(0); expect(result.stdout).toBe(""); expect(await Bun.file(marker).exists()).toBe(false);
});

test("selector output accepts merge labels without expanding unrelated aliases or rounding decimal literals", () => {
  const source = `common: &common {app: api}\nmetadata:\n  labels:\n    <<: *common\nvalue: &value example\nrepeated: [${Array(150).fill("*value").join(", ")}]\nprecise: 1.00000000000000000001\nexponent: 1.234567890123456789e-20\n`;
  const output = selectDocuments("data.yaml", source, labelSelector("app=api"))!;
  expect(output).not.toContain("%YAML 1.2"); expect(output).toContain("1.00000000000000000001"); expect(output).toContain("1.234567890123456789e-20");
  expect(selectDocuments("merged.yaml", "defaults: &defaults {metadata: {labels: {app: api}}}\n<<: *defaults\n", labelSelector("app=api"))).toBeDefined();
  expect(selectDocuments("literal.yaml", '"<<": {metadata: {labels: {app: api}}}\n', labelSelector("app=api"))).toBeUndefined();
  expect(output).toContain("*value"); expect(output).toContain("*common");
  expect(selectDocuments("empty.yaml", "# comment\n---\n", labelSelector("!app"))).toBeUndefined();
});

test("bunkodata rejects omitted files and no-match still validates explicit execution options", async () => {
  const f = await fixture(); await mkdir(join(f.source, "bunkodata")); await writeFile(join(f.source, "bunkodata/.env"), "EXAMPLE=fixture");
  await expect(build({ path: f.source, baseLayout: f.base, output: join(f.root, "image"), push: false, localCache: false })).rejects.toThrow("Excluded source name inside bunkodata");
  let read = false;
  await expect(resolveDocuments({ files: ["-"], selector: "!app", jobs: 0, stdin: async () => { read = true; return ""; } })).rejects.toThrow("--jobs");
  expect(read).toBe(false);
});
