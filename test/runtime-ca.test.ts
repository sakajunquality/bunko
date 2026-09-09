import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:https";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { assertBaseDataPaths } from "../packages/bunko/runtime-ca.ts";
import { provenance } from "../packages/bunko/attest.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { baseLayout, inspectTar, project, temporary } from "./helpers.ts";
import { command } from "./command.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test.each(["bundle", "source"])("%s images export declared runtime CA trust and verify a private TLS server", async (mode) => {
  const directory = await temporary(); roots.push(directory);
  const source = await project(join(directory, "source"), { bunko: { runtime: { caCertificates: ["certs/ca.pem"] } } });
  await mkdir(join(source, "certs"));
  const cert = join(source, "certs/ca.pem"), key = join(directory, "key.pem");
  await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", key, "-out", cert]);
  const server = createServer({ cert: await readFile(cert), key: await readFile(key) }, (_request, response) => response.end("runtime TLS works"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const url = `https://localhost:${(server.address() as { port: number }).port}`;
    await writeFile(join(source, "src/server.ts"), `console.log(await (await fetch(${JSON.stringify(url)})).text());`);
    const result = await build({ path: source, mode, baseLayout: await baseLayout(join(directory, "base")), output: join(directory, "image"), push: false, localCache: false, gitMetadata: false });
    const store = new BlobStore(result.layout!), extracted = join(directory, "extracted"); await mkdir(extracted);
    const tarEntries = (await Promise.all(result.layers.map((layer) => inspectTar(store.path(layer.descriptor.digest))))).flat();
    expect(tarEntries.find((entry) => entry.name === "app/.bunko-ca/roots.pem")!.mode).toBe(0o444);
    expect(result.runtimeCA!.certificates).toBe(1);
    expect(provenance(result).predicate.buildDefinition.resolvedDependencies).toContainEqual({ uri: "urn:bunko:runtime-ca", digest: { sha256: result.runtimeCA!.digest.slice(7) } });
    expect(JSON.stringify(result)).not.toContain(cert); expect(JSON.stringify(result)).not.toContain("BEGIN CERTIFICATE");
    await command(["python3", "-c", "import sys,tarfile\nfor p in sys.argv[2:]:\n with tarfile.open(p) as t:t.extractall(sys.argv[1],filter='data')", extracted, ...result.layers.map((layer) => store.path(layer.descriptor.digest))]);
    const config = JSON.parse(Buffer.from(await store.read(result.config)).toString()).config;
    expect(config.Env).toContain("NODE_EXTRA_CA_CERTS=/app/.bunko-ca/roots.pem");
    const args = config.Entrypoint.slice(1).map((arg: string) => arg.startsWith("/") ? join(extracted, arg) : arg);
    const child = Bun.spawn([process.execPath, ...args], { cwd: join(extracted, "app"), env: { PATH: process.env.PATH!, NODE_EXTRA_CA_CERTS: join(extracted, result.runtimeCA!.path) }, stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(error).toBe(""); expect(out.trim()).toBe("runtime TLS works");
    await writeFile(cert, await readFile(key));
    await expect(build({ path: source, mode, baseLayout: join(directory, "base"), output: join(directory, "bad"), push: false, localCache: false })).rejects.toThrow("Runtime CA");
  } finally { server.closeAllConnections(); server.close(); }
});

test("data destinations reject base links, parent files and incompatible existing entries", () => {
  const entries = [{ type: "file" as const, path: "app/.bunko-ca/roots.pem", content: Buffer.from("fixture") }];
  for (const type of ["symlink", "link", "file"]) expect(() => assertBaseDataPaths(new Map([["app/.bunko-ca", { type, mode: 0o755, size: 1, link: "elsewhere" }]]), entries)).toThrow("parent");
  expect(() => assertBaseDataPaths(new Map([["app/.bunko-ca/roots.pem", { type: "directory", mode: 0o755, size: 0 }]]), entries)).toThrow("incompatible");
});

test("runtime CA inputs reject traversal and symlinked path components", async () => {
  const { loadProject } = await import("../packages/bunko/config.ts");
  const { runtimeCA } = await import("../packages/bunko/runtime-ca.ts");
  const { symlink } = await import("node:fs/promises");
  const directory = await temporary(); roots.push(directory);
  const source = await project(join(directory, "source"));
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "fixture", module: "src/server.ts", bunko: { runtime: { caCertificates: ["../outside.pem"] } } }));
  await expect(loadProject({ path: source })).rejects.toThrow();
  await mkdir(join(directory, "certificates"));
  await writeFile(join(directory, "certificates/root.pem"), "certificate fixture");
  await symlink(join(directory, "certificates"), join(source, "certs"));
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "fixture", module: "src/server.ts", bunko: { runtime: { caCertificates: ["certs/root.pem"] } } }));
  await expect(runtimeCA(await loadProject({ path: source }))).rejects.toThrow("symlinks");
});
