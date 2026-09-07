import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assetInputs } from "../packages/bunko/cache.ts";
import { booleanArguments } from "../packages/bunko/cli.ts";
import { dependencyClosure } from "../packages/bunko/closure.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { dependencyPlan, installDependencies, runtimeEntries } from "../packages/bunko/deps.ts";
import { assertNoLayerCollision, rejectMacros, snapshot } from "../packages/bunko/files.ts";
import { resolveDocuments } from "../packages/bunko/resolve.ts";
import { bundle, selectToolchain } from "../packages/bunko/toolchain.ts";
import { discover } from "../packages/bunko/workspace.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { RegistryClient, type Fetcher } from "../packages/oci/registry.ts";
import { Publisher } from "../packages/oci/publish.ts";
import { packLayer, type TarEntry } from "../packages/oci/tar.ts";
import { media } from "../packages/oci/types.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { baseLayout, cli, inspectTar, project, temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function dir() { const root = await temporary(); directories.push(root); return root; }
const platform = { os: "linux", architecture: "amd64" } as const;

test("macro detection ignores documentation, strings, regexes, template text and object properties", async () => {
  const root = await dir(), file = join(root, "source.tsx");
  await writeFile(file, [
    '// import f from "x" with { type: "macro" };',
    '/* assert { type: "macro" } */',
    'const a = "with {", b = \'macro:hello\', c = `assert { macro:example`;',
    'const regex = /with {2}/; const obj = { with: {}, assert: {} };',
    'const jsx = <p>import x from "y" with {"{"}</p>;',
  ].join("\n"));
  await rejectMacros(file, file);
  // Real starter-project dev dependencies contain examples of import attributes.
  for (const packageFile of ["typescript/lib/typescript.js", "bun-types/bun.d.ts"]) {
    const path = resolve("node_modules", packageFile);
    await rejectMacros(path, path);
  }
});

test.each([
  'import value from "./macro.ts" with /* comment */ { type: "macro" };',
  'import value from "./macro.ts" assert { type: "macro" };',
  'export { value } from "./macro.ts" with { type: "macro" };',
  'import value from "macro:./macro.ts";',
  'import("macro:./macro.ts");',
  'import("./macro.ts", { with: { type: "macro" } });',
  'const text = `safe ${import("macro:./macro.ts")}`;',
])("rejects executable macro syntax without executing it: %s", async (code) => {
  const root = await dir(), file = join(root, "source.ts");
  await writeFile(file, code);
  await writeFile(join(root, "macro.ts"), 'Bun.write(new URL("./executed", import.meta.url), "unsafe"); export default () => 1;');
  await expect(rejectMacros(file, file)).rejects.toThrow("macros are not supported");
  expect(await Bun.file(join(root, "executed")).exists()).toBe(false);
});

test("bundles a starter application alongside installed TypeScript and Bun type definitions", async () => {
  const root = await dir(), source = await project(join(root, "app"));
  for (const name of ["typescript", "bun-types"]) await cp(resolve("node_modules", name), join(source, "node_modules", name), { recursive: true });
  const output = await bundle(await loadProject({ path: source }), await selectToolchain(), source, () => {});
  expect(await readFile(join(output.outdir, output.entry), "utf8")).toContain("hello bunko");
}, 15000);

test("the default download cache stays outside the production dependency layer", async () => {
  const root = await dir(), f = await dependencyFixture(root), stage = join(root, "stage");
  await cp(f.source, stage, { recursive: true });
  await cp(f.cache, join(stage, ".bunko-build/install-cache"), { recursive: true });
  const selected = await loadProject({ path: f.source });
  await installDependencies(stage, await dependencyPlan(selected, stage), await selectToolchain(), platform);
  const content = await runtimeEntries(stage, "app", platform);
  expect(content.inventory.map((p) => p.name)).toEqual(["fixture-msg"]);
  expect(content.entries.some((entry) => entry.path.includes(".bun-cache") || entry.path.includes("install-cache"))).toBe(false);
  const explicit = join(root, "explicit"); await cp(f.source, explicit, { recursive: true });
  await installDependencies(explicit, await dependencyPlan(selected, explicit), await selectToolchain(), platform, f.cache);
  const store = new BlobStore(join(root, "blobs"));
  expect((await packLayer(store, content.entries, "deps", 0))!.descriptor.digest).toBe((await packLayer(store, (await runtimeEntries(explicit, "app", platform)).entries, "deps", 0))!.descriptor.digest);
});

test.each([["registry.example:443", false], ["localhost:80", true]] as const)("authenticates normalized default ports at %s without leaking redirected credentials", async (registry, insecure) => {
  const origins: string[] = [], credentials: string[] = [];
  const client = new RegistryClient(registry, {
    insecure: insecure ? [registry] : undefined,
    credentials: async (host) => { credentials.push(host); return { username: "user", password: "secret" }; },
    fetcher: async (url, init) => {
      const u = new URL(url), auth = new Headers(init?.headers).get("Authorization");
      origins.push(u.origin);
      if (u.hostname === "storage.example") { expect(auth).toBeNull(); return new Response("payload"); }
      if (!auth) return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="registry"' } });
      expect(auth).toBe(`Basic ${Buffer.from("user:secret").toString("base64")}`);
      return new Response(null, { status: 307, headers: { Location: "https://storage.example/blob" } });
    },
  });
  expect(await (await client.request("/v2/app/blobs/digest")).text()).toBe("payload");
  expect(credentials).toEqual([registry]);
  expect(origins.slice(0, 2)).toEqual([client.origin, client.origin]);
  await expect(client.request("http://other.example/v2/")).rejects.toThrow("HTTPS");
});

test("response bodies and upload requests can outlive the read-header deadline", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetcher: Fetcher = async (_url, init) => {
    signals.push(init?.signal);
    if (init?.method === "PATCH") {
      await Bun.sleep(60);
      init.signal?.throwIfAborted();
      return new Response(null, { status: 202 });
    }
    return new Response(new ReadableStream({ async start(controller) {
      init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted response body")), { once: true });
      await Bun.sleep(60);
      if (!init?.signal?.aborted) { controller.enqueue(Buffer.from("slow body")); controller.close(); }
    } }));
  };
  const client = new RegistryClient("registry.example", { fetcher, headersTimeoutMs: 10, retries: 0 });
  expect(await (await client.request("/v2/app/blobs/digest")).text()).toBe("slow body");
  expect((await client.request("/v2/app/blobs/uploads/id", { method: "PATCH", body: "chunk" })).status).toBe(202);
  expect(signals.every((signal) => !signal?.aborted)).toBe(true);
});

test("read-header timeouts retry within bounds and caller cancellation remains effective", async () => {
  let attempts = 0;
  const client = new RegistryClient("registry.example", { headersTimeoutMs: 10, retries: 1, sleep: async () => {}, fetcher: (_url, init) => new Promise((_resolve, reject) => {
    attempts++;
    if (init?.signal?.aborted) reject(init.signal.reason);
    else init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }) });
  await expect(client.request("/v2/")).rejects.toThrow("connection failed");
  expect(attempts).toBe(2);
  await expect(client.request("/v2/", { signal: AbortSignal.abort(new Error("caller cancelled")) })).rejects.toThrow("caller cancelled");
  expect(attempts).toBe(3);
});

test.each([false, true])("upload recovery preserves the last URL when status omits Location (empty=%s)", async (empty) => {
  const store = new BlobStore(await dir()), registry = new MockRegistry();
  registry.disconnectPatch = !empty; registry.disconnectBeforePatch = empty;
  const fetcher: Fetcher = async (url, init) => {
    const response = await registry.fetch(url, init);
    if ((!init?.method || init.method === "GET") && new URL(url).pathname.includes("/uploads/")) response.headers.delete("Location");
    return response;
  };
  const bytes = Buffer.alloc(9 * 1024 * 1024, 7), descriptor = await store.put(bytes, media.gzip);
  await new Publisher("registry.example/app", { fetcher }).blob(store, descriptor);
  expect(registry.blobs.get(`registry.example/app/${descriptor.digest}`)).toEqual(bytes);
});

test("hashes large dependency trees under a low file descriptor limit", async () => {
  const root = await dir(), file = join(root, "payload"); await writeFile(file, "payload");
  const script = join(root, "hash.ts");
  await writeFile(script, `import { assetInputs } from ${JSON.stringify(resolve("packages/bunko/cache.ts"))};\nconst entries = Array.from({length: 2048}, (_, i) => ({type: "file", path: String(i), source: ${JSON.stringify(file)}, size: 7}));\nconsole.log(JSON.stringify(await assetInputs(entries)));`);
  const child = Bun.spawn(["sh", "-c", 'ulimit -n 256; exec "$@"', "bunko-hash-test", process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(exit).toBe(0);
  const inputs = JSON.parse(stdout);
  expect(inputs).toHaveLength(2048);
  expect(inputs[2047]).toEqual({ type: "file", path: "2047", executable: false, digest: sha256(Buffer.from("payload")) });
  await expect(assetInputs([{ type: "file", path: "missing", source: join(root, "missing"), size: 0 }])).rejects.toThrow();
});

test("nested bundled dependencies retain real directories, data and executable aliases", async () => {
  const root = await dir(), source = await project(join(root, "app"), { dependencies: { parent: "1.0.0" }, bunko: { external: ["parent"] } });
  const parent = join(source, "node_modules/parent"), child = join(parent, "node_modules/child");
  await mkdir(child, { recursive: true });
  await writeFile(join(parent, "package.json"), JSON.stringify({ name: "parent", version: "1.0.0", dependencies: { child: "1.0.0" }, bundledDependencies: ["child"] }));
  await writeFile(join(parent, "index.js"), 'module.exports = require("child");');
  await writeFile(join(child, "package.json"), JSON.stringify({ name: "child", version: "1.0.0", main: "index.js", bin: { child: "index.js" } }));
  await writeFile(join(child, "index.js"), 'module.exports = "nested data";');
  const content = await dependencyClosure(source, "app", platform, [await loadProject({ path: source })]);
  const store = new BlobStore(join(root, "blobs"));
  const layer = await packLayer(store, [...content.entries, ...content.aliases.get("")!], "deps", 0);
  const entries = await inspectTar(store.path(layer!.descriptor.digest));
  const path = "app/.bunko-deps/node_modules/parent/node_modules/child";
  expect(entries.filter((entry) => entry.name === path)).toHaveLength(1);
  expect(entries.find((entry) => entry.name === path)!.linkname).toBe("");
  expect(entries.find((entry) => entry.name === dirname(path) + "/.bin/child")!.linkname).toBe("../child/index.js");
  const out = join(root, "out"); await mkdir(out);
  const extract = Bun.spawn(["tar", "-xzf", store.path(layer!.descriptor.digest), "-C", out], { stdout: "pipe", stderr: "pipe" });
  expect(await extract.exited).toBe(0);
  const run = Bun.spawn([process.execPath, "-e", 'console.log(require("./node_modules/parent"))'], { cwd: join(out, "app"), stdout: "pipe", stderr: "pipe" });
  expect(await new Response(run.stdout).text()).toBe("nested data\n"); expect(await run.exited).toBe(0);
});

test("standalone projects ignore unrelated or malformed ancestor workspaces", async () => {
  const root = await dir(), source = await project(join(root, "standalone"));
  await writeFile(join(root, "package.json"), '{"workspaces":["packages/*"]}');
  expect((await discover({ path: source })).workspace).toBeUndefined();
  await writeFile(join(root, "package.json"), '{"workspaces":');
  expect((await discover({ path: source })).directory).toBe(await realpath(source));
  // An explicitly selected broken project remains an error.
  await expect(discover({ path: root })).rejects.toThrow();
  await writeFile(join(root, "package.json"), '{"workspaces":["standalone"]}');
  expect((await discover({ path: source })).workspace!.directory).toBe(await realpath(root));
  expect((await discover({ path: root, targets: ["."] })).targets[0]!.path).toBe("");
});

test.each(['image: |\n  bunko://app\n', 'image: "bunko://app "\n', 'image: "bunko://app\\t"\n', '{"image":"bunko://app\\n"}', 'image: "bunko://app?tag=x"\n'])("invalid references fail before source discovery or registry requests: %s", async (source) => {
  const root = await dir(); let requests = 0;
  await expect(resolveDocuments({ files: ["-"], context: join(root, "missing"), stdin: async () => source, repo: "registry.example/team", registry: { fetcher: async () => { requests++; return new Response(); } } })).rejects.toThrow("Invalid bunko reference");
  expect(requests).toBe(0);
});

test("explicit boolean values cover every flag and preserve string values and -- positionals", async () => {
  const options = { push: { type: "boolean" }, index: { type: "boolean" }, "dry-run": { type: "boolean" }, filename: { type: "string", short: "f" } } as const;
  expect(booleanArguments(["--index=false", "--dry-run=true", "--no-push=false", "-f", "--index=false", "--", "--dry-run=true"], options)).toEqual(["--no-index", "--dry-run", "--push", "-f", "--index=false", "--", "--dry-run=true"]);
  const root = await dir(), source = await project(join(root, "app")), base = await baseLayout(join(root, "base")), report = join(root, "report.json");
  const result = await cli(["build", source, "--push=false", "--index=false", "--dry-run=true", "--git-metadata=false", "--base-layout", base, "--report", report]);
  expect(result.exit).toBe(0); expect(result.stdout).toBe("");
  const data = JSON.parse(await readFile(report, "utf8"));
  expect(data.dryRun).toBe(true); expect(data.root.mediaType).toBe(media.manifest);
  expect((await cli(["build", source, "--index=invalid"])).exit).toBe(1);
});

test("layer collisions include implicit parents in either order and scale to large trees", () => {
  const file = (path: string): TarEntry => ({ path, type: "file", content: Buffer.from("x") });
  for (const entries of [[file("app/a"), file("app/a/b")], [file("app/a/b"), file("app/a")], [file("app/A/b"), file("app/a/c")]]) expect(() => assertNoLayerCollision([entries])).toThrow();
  expect(() => assertNoLayerCollision([[{ path: "app", type: "directory" }], [{ path: "app", type: "directory" }, file("app/a")]])).not.toThrow();
  const entries = Array.from({ length: 40000 }, (_, i) => file(`app/node_modules/pkg-${i}/index.js`));
  const start = performance.now(); assertNoLayerCollision([entries]);
  expect(performance.now() - start).toBeLessThan(3000);
});

test("starter editor metadata is excluded without relaxing source symlink validation", async () => {
  const root = await dir(), source = await project(join(root, "app"));
  await mkdir(join(source, ".cursor/rules"), { recursive: true });
  await writeFile(join(source, "CLAUDE.md"), "Use Bun.");
  await symlink("../../CLAUDE.md", join(source, ".cursor/rules/use-bun.mdc"));
  const output = join(root, "snapshot");
  await snapshot(source, output);
  expect(await Bun.file(join(output, ".cursor/rules/use-bun.mdc")).exists()).toBe(false);
  await symlink("server.ts", join(source, "src/link.ts"));
  await expect(snapshot(source, join(root, "rejected"))).rejects.toThrow("Source symlinks");
});
