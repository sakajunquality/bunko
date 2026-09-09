import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { certificatePEM, installNetworkEnvironment, npmCertificate, validateInstallCertificates } from "../packages/bunko/install-network.ts";
import { dependencyInputs, dependencyPlan, installDependencies } from "../packages/bunko/deps.ts";
import { loadProject } from "../packages/bunko/config.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { temporary } from "./helpers.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { command } from "./command.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("isolated installer retains proxy bypass, explicit empty overrides and absolute host certificate paths", () => {
  const environment = installNetworkEnvironment({ HTTPS_PROXY: "https://user:pass@proxy.example", https_proxy: "", NO_PROXY: "localhost,.internal", http_proxy: "http://proxy.example", no_proxy: "internal.example", NODE_EXTRA_CA_CERTS: "certs/root.pem", SSL_CERT_FILE: "", SECRET: "hidden", NODE_OPTIONS: "--require=unexpected" });
  expect(environment.https_proxy).toBe(""); expect(environment.NO_PROXY).toBe("localhost,.internal");
  expect(environment.no_proxy).toBe("internal.example"); expect(environment.NODE_EXTRA_CA_CERTS).toBe(resolve("certs/root.pem"));
  expect(environment.SSL_CERT_FILE).toBe(""); expect(environment.SECRET).toBeUndefined(); expect(environment.NODE_OPTIONS).toBeUndefined();
});

test("npm cafile uses original project paths, remains outside cache metadata, and is removed after installation", async () => {
  const root = await temporary(); roots.push(root);
  const fixture = await dependencyFixture(root), certificate = join(fixture.source, "ca.pem");
  await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", join(root, "key.pem"), "-out", certificate]);
  await writeFile(join(fixture.source, ".npmrc"), "cafile=ca.pem\n");
  const project = await loadProject({ path: fixture.source }), plan = await dependencyPlan(project, fixture.source), toolchain = await selectToolchain();
  expect(plan.npmCertificate!.pem).toBe(await readFile(certificate, "utf8"));
  const annotated = join(root, "annotated.pem");
  await writeFile(annotated, "# Corporate CA bundle\nSubject: localhost\n" + plan.npmCertificate!.pem);
  expect(await certificatePEM(annotated)).toBe(plan.npmCertificate!.pem);
  await writeFile(annotated, plan.npmCertificate!.pem + await readFile(join(root, "key.pem"), "utf8"));
  await expect(certificatePEM(annotated)).rejects.toThrow("PEM certificate");
  expect(plan.npmrc).not.toContain("cafile");
  const inputs = JSON.stringify(dependencyInputs(plan, toolchain, { os: "linux", architecture: "amd64" }, "base", project));
  expect(inputs).not.toContain(certificate); expect(inputs).not.toContain("BEGIN CERTIFICATE");
  const stage = join(root, "stage"); await cp(fixture.source, stage, { recursive: true }); await rm(join(stage, "ca.pem"));
  await installDependencies(stage, plan, toolchain, undefined, fixture.cache);
  expect(await Bun.file(join(stage, ".bunko-build/install-home/npm-ca.pem")).exists()).toBe(false);
  await writeFile(join(fixture.source, ".npmrc"), "cafile=${UNSET_TEST_CA_PATH}\n");
  await expect(npmCertificate(fixture.source)).rejects.toThrow("environment variable");
  await expect(npmCertificate(fixture.source, false)).resolves.toBeUndefined();
  await writeFile(certificate, "private key or invalid certificate");
  await writeFile(join(fixture.source, ".npmrc"), "cafile=ca.pem\n");
  await expect(npmCertificate(fixture.source)).rejects.toThrow("PEM certificate");
  await writeFile(join(fixture.source, ".npmrc"), "cafile=ca.pem\ncafile=another.pem\n");
  await expect(npmCertificate(fixture.source)).rejects.toThrow("once");
});

test("real Bun installs trust a private npm CA through a CONNECT proxy and honor NO_PROXY", async () => {
  const { createServer: httpsServer } = await import("node:https");
  const { createServer: httpServer } = await import("node:http");
  const { connect } = await import("node:net");
  const { createHash } = await import("node:crypto");
  const root = await temporary(); roots.push(root);
  const certificate = join(root, "ca.pem"), key = join(root, "key.pem"), packageDirectory = join(root, "package");
  await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", key, "-out", certificate]);
  await mkdir(packageDirectory);
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: "private-ca-fixture", version: "1.0.0", main: "index.js" }));
  await writeFile(join(packageDirectory, "index.js"), 'module.exports="private CA works";');
  const extraCertificate = join(root, "extra-ca.pem"), extraKey = join(root, "extra-key.pem");
  await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=extra-ca", "-addext", "subjectAltName=DNS:localhost", "-keyout", extraKey, "-out", extraCertificate]);
  const archive = join(root, "package.tgz"); await command(["tar", "-czf", archive, "-C", root, "package"]);
  const tarball = await readFile(archive), integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  let registryURL = "", tarballURL = "", connections = 0;
  const tarballServer = httpsServer({ cert: await readFile(extraCertificate), key: await readFile(extraKey) }, (_request, response) => response.end(tarball));
  const registry = httpsServer({ cert: await readFile(certificate), key: await readFile(key) }, (request, response) => {
    if (request.url === "/package.tgz") { response.end(tarball); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ name: "private-ca-fixture", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "private-ca-fixture", version: "1.0.0", dist: { tarball: `${tarballURL}/package.tgz`, integrity } } } }));
  });
  const proxy = httpServer((_request, response) => { response.writeHead(502); response.end(); });
  proxy.on("connect", (request, socket, head) => {
    connections++;
    const address = new URL(`http://${request.url}`);
    const upstream = connect(Number(address.port), "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); upstream.write(head); socket.pipe(upstream); upstream.pipe(socket); });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
  });
  await new Promise<void>((done) => registry.listen(0, "127.0.0.1", done));
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  await new Promise<void>((done) => tarballServer.listen(0, "127.0.0.1", done));
  tarballURL = `https://localhost:${(tarballServer.address() as { port: number }).port}`;
  registryURL = `https://localhost:${(registry.address() as { port: number }).port}`;
  const proxyURL = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const lockTrust = join(root, "lock-trust.pem");
    await writeFile(lockTrust, await readFile(certificate, "utf8") + await readFile(extraCertificate, "utf8"));
    process.env.NODE_EXTRA_CA_CERTS = lockTrust;
    process.env.HTTPS_PROXY = proxyURL; process.env.NO_PROXY = "localhost";
    const source = join(root, "source"); await mkdir(source);
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "tls-app", module: "index.ts", dependencies: { "private-ca-fixture": "1.0.0" } }));
    await writeFile(join(source, "index.ts"), "console.log(1)");
    await writeFile(join(source, ".npmrc"), `registry=${registryURL}\ncafile=../ca.pem\n`);
    const child = Bun.spawn([process.execPath, "install", "--ignore-scripts", "--lockfile-only", `--cafile=${certificate}`, `--registry=${registryURL}`, `--cache-dir=${join(root, "lock-cache")}`], { cwd: source, env: { HOME: root, PATH: process.env.PATH!, ...installNetworkEnvironment() }, stdout: "pipe", stderr: "pipe" });
    const [, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(error);
    process.env.NODE_EXTRA_CA_CERTS = extraCertificate;
    const plan = await dependencyPlan(await loadProject({ path: source }), source), toolchain = await selectToolchain();
    process.env.NO_PROXY = "";
    const before = connections;
    await installDependencies(source, plan, toolchain, undefined, join(root, "proxy-cache"));
    expect(connections).toBeGreaterThan(before);
    expect(await readFile(join(source, "node_modules/private-ca-fixture/index.js"), "utf8")).toContain("private CA works");
    await rm(join(source, "node_modules"), { recursive: true });
    process.env.NO_PROXY = "localhost";
    const bypass = connections;
    await installDependencies(source, plan, toolchain, undefined, join(root, "bypass-cache"));
    expect(connections).toBe(bypass);
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    tarballServer.closeAllConnections(); tarballServer.close();
    registry.closeAllConnections(); registry.close(); proxy.closeAllConnections(); proxy.close();
  }
}, 15000);


test("host CA validation is independent of npm cafile and does not expose paths or contents", async () => {
  const root = await temporary(); roots.push(root);
  const path = join(root, "SECRET_PATH.pem"); await writeFile(path, "SECRET_INVALID_CERTIFICATE");
  expect(await validateInstallCertificates({ NODE_EXTRA_CA_CERTS: "", SSL_CERT_FILE: "" })).toBe("");
  for (const key of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
    try { await validateInstallCertificates({ [key]: path }); throw new Error("Expected rejection"); }
    catch (error) { expect(String(error)).toContain(key); expect(String(error)).not.toContain("SECRET"); expect(String(error)).not.toContain(root); }
  }
  const f = await dependencyFixture(join(root, "dependency"));
  const plan = await dependencyPlan(await loadProject({ path: f.source }), f.source), toolchain = await selectToolchain();
  const old = process.env.NODE_EXTRA_CA_CERTS;
  try {
    process.env.NODE_EXTRA_CA_CERTS = path;
    await expect(installDependencies(f.source, plan, toolchain, undefined, f.cache)).rejects.toThrow("NODE_EXTRA_CA_CERTS");
  } finally { if (old === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = old; }
});
