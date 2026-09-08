import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:https";
import { RegistryClient } from "../packages/oci/registry.ts";
import { registryTLS } from "../packages/oci/tls.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { decodeLayer } from "../packages/oci/decode.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { media } from "../packages/oci/types.ts";
import { temporary, project, baseLayout, inspectTar } from "./helpers.ts";
import { command } from "./command.ts";
import { build } from "../packages/bunko/build.ts";
import { dependencyMap } from "../packages/bunko/dependency-map.ts";
import { packDependencies } from "../packages/bunko/external-deps.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function root() { const path = await temporary(); roots.push(path); return path; }

test("zstd layers enforce decoded size, digest and complete frame validation", async () => {
  const r = await root(), store = new BlobStore(join(r, "store")), bytes = Buffer.alloc(128 * 1024, 42);
  const compressed = Bun.zstdCompressSync(bytes), d = await store.put(compressed, media.zstd);
  await decodeLayer(store, d, sha256(bytes), join(r, "decoded"), bytes.length);
  expect(await readFile(join(r, "decoded"))).toEqual(bytes);
  await expect(decodeLayer(store, d, sha256(bytes), undefined, 100)).rejects.toThrow("size limit");
  await expect(decodeLayer(store, d, sha256(Buffer.from("wrong")))).rejects.toThrow("DiffID");
  const truncated = await store.put(compressed.subarray(0, compressed.length - 1), media.zstd);
  await expect(decodeLayer(store, truncated, sha256(bytes))).rejects.toThrow();
});

test("registry TLS requires a trusted server and scoped client credentials", async () => {
  const r = await root(), cert = join(r, "cert.pem"), key = join(r, "key.pem");
  await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", key, "-out", cert]);
  const server = createServer({ cert: await readFile(cert), key: await readFile(key), ca: await readFile(cert), requestCert: true, rejectUnauthorized: true }, (_request, response) => { response.end("verified"); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const port = (server.address() as { port: number }).port, host = `localhost:${port}`;
    const options = { retries: 0, credentials: async () => undefined };
    await expect(new RegistryClient(host, options).request("/v2/", {}, [])).rejects.toThrow();
    const config = join(r, "tls.json");
    await writeFile(config, JSON.stringify({ [host]: { ca: "cert.pem", cert: "cert.pem", key: "key.pem" } }));
    const { hosts: tls } = await registryTLS(config);
    await expect(new RegistryClient(host, { ...options, tls: { [`https://${host}`]: { ca: tls[`https://${host}`]!.ca } } }).request("/v2/", {}, [])).rejects.toThrow();
    const client = new RegistryClient(host, { ...options, tls });
    expect(await (await client.request("/v2/", {}, [])).text()).toBe("verified");
    const captured: unknown[] = [];
    const redirected = new RegistryClient(host, { ...options, tls, fetcher: async (_url, init) => {
      captured.push((init as RequestInit & { tls?: unknown }).tls);
      return captured.length === 1 ? new Response(null, { status: 307, headers: { Location: "https://other.test/blob" } }) : new Response("ok");
    } });
    await (await redirected.request("/v2/", {}, [])).body?.cancel();
    expect(captured[0]).toBeDefined(); expect(captured[1]).toBeUndefined();
    await writeFile(config, JSON.stringify({ "localhost:443": { ca: "cert.pem" }, localhost: { ca: "cert.pem" } }));
    await expect(registryTLS(config)).rejects.toThrow("Duplicate");
  } finally { await new Promise<void>((done) => server.close(() => done())); }
}, 15_000);

test("TLS files addressed through directory aliases never enter assets or source identity", async () => {
  const r = await root(), source = await project(join(r, "source"), { bunko: { assets: ["public"] } });
  await mkdir(join(source, "public")); await writeFile(join(source, "public/message.txt"), "public");
  const alias = join(r, "alias"); await symlink(source, alias);
  const secret = join(source, "public/client.pem"), config = join(alias, "public/tls.json");
  await writeFile(secret, "-----BEGIN PRIVATE KEY-----\nSENSITIVE ONE\n");
  await writeFile(config, JSON.stringify({ "registry.test": { cert: "client.pem", key: "client.pem" } }));
  const tls = await registryTLS(config), base = await baseLayout(join(r, "base"));
  const options = { path: alias, baseLayout: base, push: false, localCache: false, gitMetadata: false, registry: { tls: tls.hosts, sensitivePaths: tls.files } };
  const first = await build({ ...options, output: join(r, "first") });
  const asset = first.layers.find((layer) => layer.kind === "assets")!;
  const entries = await inspectTar(new BlobStore(first.layout!).path(asset.descriptor.digest));
  expect(entries.map((e) => e.name)).not.toContain("app/public/client.pem");
  expect(entries.map((e) => e.name)).not.toContain("app/public/tls.json");
  await writeFile(secret, "-----BEGIN PRIVATE KEY-----\nSENSITIVE TWO\n");
  expect((await build({ ...options, output: join(r, "second") })).sourceDigest).toBe(first.sourceDigest);
});

test("dependency map paths are canonicalized and duplicate targets fail", async () => {
  const r = await root(); await mkdir(join(r, "source")); await mkdir(join(r, "layout"));
  const file = join(r, "map.json");
  await writeFile(file, JSON.stringify({ "./source": { "linux/amd64": "layout:./layout" } }));
  const map = await dependencyMap(file);
  expect(Object.values(map)[0]!["linux/amd64"]).toContain("layout:");
  await writeFile(file, JSON.stringify({ "./source": { "linux/amd64": "layout:./layout" }, source: { "linux/amd64": "layout:./layout" } }));
  await expect(dependencyMap(file)).rejects.toThrow("Duplicate");
});

test("unsupported signing TLS combinations and root-like artifact targets fail before building", async () => {
  const r = await root();
  await expect(build({ path: join(r, "absent"), signKey: "unused", registry: { tls: { "https://registry.test": { ca: "PEM" } } } })).rejects.toThrow("Integrated signing cannot use");
  await expect(packDependencies(r, join(r, "absent.lock"), { os: "linux", architecture: "amd64" }, join(r, "out"), "/app", "./")).rejects.toThrow("artifact target");
});
