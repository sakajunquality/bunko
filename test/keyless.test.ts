import { afterEach, expect, test } from "bun:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareSigning, signingMode, signConfiguredImages, verifyKeylessImage } from "../packages/bunko/keyless.ts";
import { signingEnvironment } from "../packages/bunko/cosign.ts";
import { supplyChainOptions } from "../packages/bunko/policy.ts";
import { offlineOptions } from "../packages/bunko/offline.ts";
import { build } from "../packages/bunko/build.ts";
import { baseLayout, project, temporary } from "./helpers.ts";
import { MockRegistry } from "./mock-registry.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await temporary(); dirs.push(root);
  const log = join(root, "calls.json"), exe = join(root, "cosign");
  await writeFile(exe, `#!${process.execPath}\nif(process.argv[2]==="version"){console.log('{"gitVersion":"v3.1.3"}');process.exit(0)}\nconst args=process.argv.slice(2);const i=args.indexOf('--identity-token');const token=i<0?undefined:args[i+1];const calls=await Bun.file(${JSON.stringify(log)}).json().catch(()=>[]);calls.push({args,token:token?await Bun.file(token).text():undefined,mode:token?(await import('node:fs/promises')).stat(token).then(s=>s.mode&511):undefined,oidc:process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN});if(calls.at(-1).mode)calls.at(-1).mode=await calls.at(-1).mode;await Bun.write(${JSON.stringify(log)},JSON.stringify(calls));`, { mode: 0o755 });
  return { root, exe, log };
}
const reference = `registry.test/app@sha256:${"a".repeat(64)}`;
async function profile(root: string, tlog = true, tsa = false) {
  const endpoint = (url: string) => ({ url, majorApiVersion: 1, validFor: { start: "2024-01-01T00:00:00Z" }, operator: "test" });
  await writeFile(join(root, "config.json"), JSON.stringify({ mediaType: "application/vnd.dev.sigstore.signingconfig.v0.2+json", caUrls: [endpoint("https://fulcio.test")], oidcUrls: [endpoint("https://issuer.test")], ...(tlog ? { rekorTlogUrls: [endpoint("https://rekor.test")], rekorTlogConfig: { selector: "ANY" } } : {}), ...(tsa ? { tsaUrls: [endpoint("https://tsa.test")], tsaConfig: { selector: "ANY" } } : {}) }));
  await writeFile(join(root, "root.json"), JSON.stringify({ mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1" }));
  const path = join(root, "profile.json"); await writeFile(path, JSON.stringify({ schemaVersion: 1, signingConfig: "config.json", trustedRoot: "root.json" })); return path;
}
test("signing modes retain key defaults and CI/offline contracts", () => {
  expect(signingMode({ signKey: "key" })).toBe("key");
  expect(() => signingMode({ sign: "keyless", signKey: "key" })).toThrow();
  expect(() => signingMode({ sign: "key" })).toThrow();
  expect(() => signingMode({ signIdentityToken: "secret" })).toThrow();
  expect(supplyChainOptions({ sign: "keyless", supplyChainPolicy: "ci", reproducible: true })).toMatchObject({ sbom: true, provenance: true });
  expect(() => offlineOptions({ path: ".", offline: true, baseLayout: "/base", sign: "keyless" })).toThrow("signature");
});
test("tokens are passed through private temporary files, deduplicated and cleaned", async () => {
  const f = await fixture(), token = "TOKEN_NEVER_IN_ARGUMENTS", input = join(f.root, "identity"); await writeFile(input, `${token}\n`);
  const prepared = (await prepareSigning({ sign: "keyless", signIdentityToken: `@${input}` }))!;
  expect(prepared.paths).toContain(input); expect(JSON.stringify(prepared.metadata)).not.toContain(token);
  await signConfiguredImages([reference, reference], prepared, f.exe);
  const calls = JSON.parse(await readFile(f.log, "utf8")); expect(calls).toHaveLength(1);
  expect(calls[0].args.join(" ")).not.toContain(token); expect(calls[0].token).toBe(token); expect(calls[0].mode).toBe(0o600);
  expect(calls[0].args).not.toContain("--use-signing-config=false"); expect(calls[0].args).toContain("--oidc-disable-ambient-providers");
  const tokenPath = calls[0].args[calls[0].args.indexOf("--identity-token") + 1]; await expect(stat(tokenPath)).rejects.toThrow();
  await expect(signConfiguredImages(["registry.test/app:latest"], prepared, f.exe)).rejects.toThrow("immutable");
});
test("custom native profiles freeze trust and require Rekor or TSA", async () => {
  const f = await fixture();
  await expect(prepareSigning({ sign: "keyless", signIdentityToken: "token", signTlog: false })).rejects.toThrow("TSA");
  const path = await profile(f.root);
  const prepared = (await prepareSigning({ sign: "keyless", signIdentityToken: "token", sigstoreConfig: path }))!;
  expect(prepared.metadata).toMatchObject({ mode: "keyless", service: "custom", tlog: true }); expect(prepared.paths).toHaveLength(3);
  await signConfiguredImages([reference], prepared, f.exe);
  const calls = JSON.parse(await readFile(f.log, "utf8")); expect(calls[0].args).toContain("--signing-config"); expect(calls[0].args).toContain("--trusted-root");
  await expect(prepareSigning({ sign: "keyless", signIdentityToken: "token", sigstoreConfig: path, signTlog: false })).rejects.toThrow("TSA");
  await profile(f.root, false, true);
  expect((await prepareSigning({ sign: "keyless", signIdentityToken: "token", sigstoreConfig: path, signTlog: false }))!.metadata.tlog).toBe(false);
  await verifyKeylessImage(reference, { identity: "https://identity.test/workflow", issuer: "https://issuer.test", sigstoreConfig: path }, f.exe);
  const verify = JSON.parse(await readFile(f.log, "utf8")).at(-1).args; expect(verify).toContain("--use-signed-timestamps"); expect(verify).toContain("--insecure-ignore-tlog");
  await writeFile(join(f.root, "config.json"), (await readFile(join(f.root, "config.json"), "utf8")).replace("https://fulcio.test", "http://fulcio.test"));
  await expect(prepareSigning({ sign: "keyless", signIdentityToken: "token", sigstoreConfig: path })).rejects.toThrow("HTTPS");
});
test("keyless verification requires identity and issuer constraints and redacts helper errors", async () => {
  const f = await fixture();
  await expect(verifyKeylessImage(reference, { identity: "user" }, f.exe)).rejects.toThrow("constraint");
  await expect(verifyKeylessImage(reference, { identity: "user", identityRegexp: ".*", issuer: "issuer" }, f.exe)).rejects.toThrow("constraint");
  await verifyKeylessImage(reference, { identityRegexp: "^https://github.com/test/", issuer: "https://issuer.test" }, f.exe);
  expect(JSON.parse(await readFile(f.log, "utf8"))[0].args).toContain("--certificate-identity-regexp");
  await writeFile(f.exe, `#!${process.execPath}\nif(process.argv[2]==="version"){console.log('{"gitVersion":"v3.1.3"}');process.exit(0)}console.error('OIDC SECRET_VALUE');process.exit(1);`, { mode: 0o755 });
  try { await signConfiguredImages([reference], (await prepareSigning({ sign: "keyless", signIdentityToken: "SECRET_VALUE" }))!, f.exe); throw new Error("Expected failure"); }
  catch (error) { expect(String(error)).toContain("OIDC identity"); expect(String(error)).not.toContain("SECRET_VALUE"); }
});
test("ambient OIDC credentials are only forwarded for keyless", () => {
  const previous = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN; process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "OIDC_SECRET";
  try { expect(signingEnvironment().ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined(); expect(signingEnvironment(true).ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe("OIDC_SECRET"); }
  finally { if (previous === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN; else process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = previous; }
});
test("build excludes token input and records only signing policy in report and provenance", async () => {
  const f = await fixture(), source = await project(join(f.root, "app")), token = join(source, "identity-token"), report = join(f.root, "report.json");
  await writeFile(token, "BUILD_SECRET"); const mock = new MockRegistry();
  const result = await build({ path: source, baseLayout: await baseLayout(join(f.root, "base")), repo: "registry.test/app", bare: true, localCache: false, registryCache: false, gitMetadata: false, mode: "source", sign: "keyless", signIdentityToken: `@${token}`, cosignPath: f.exe, provenance: true, report, registry: { fetcher: mock.fetch, credentials: async () => undefined } });
  expect(result.signing).toEqual({ mode: "keyless", service: "public", tlog: true });
  expect(await readFile(report, "utf8")).not.toContain("BUILD_SECRET");
  const { provenance } = await import("../packages/bunko/attest.ts"); expect(provenance(result).predicate.buildDefinition.externalParameters.signing).toEqual(result.signing);
  expect(JSON.stringify(result)).not.toContain("BUILD_SECRET");
  const calls = JSON.parse(await readFile(f.log, "utf8")); expect(calls.length).toBeGreaterThanOrEqual(2);
  const published = [...mock.blobs.values()]; expect(published.some((data) => Buffer.from(data).includes(Buffer.from("BUILD_SECRET")))).toBe(false);
});

test("resolve supports keyless with an explicit cosign helper", async () => {
  const f = await fixture(); await project(join(f.root, "app"));
  const mock = new MockRegistry(); const { resolveDocuments } = await import("../packages/bunko/resolve.ts");
  const result = await resolveDocuments({ context: f.root, files: ["-"], stdin: async () => "image: bunko://app\n", baseLayout: await baseLayout(join(f.root, "base")), repo: "registry.test/resolve", localCache: false, registryCache: false, sign: "keyless", signIdentityToken: "token", cosignPath: f.exe, registry: { fetcher: mock.fetch, credentials: async () => undefined } });
  expect(result.output).toContain("registry.test/resolve/"); expect(result.targets[0]!.signing?.mode).toBe("keyless");
});

test("keyless rebase signing failure leaves tags pending even without smoke", async () => {
  const f = await fixture(); const { rebaseBase } = await import("./rebase-fixture.ts"), { rebase } = await import("../packages/bunko/rebase.ts");
  const base = await rebaseBase(join(f.root, "base")), source = await project(join(f.root, "app"));
  const built = await build({ path: source, baseLayout: base.directory, output: join(f.root, "image"), localCache: false, gitMetadata: false });
  await writeFile(f.exe, `#!${process.execPath}\nif(process.argv[2]==="version"){console.log('{"gitVersion":"v3.1.3"}');process.exit(0)}process.exit(1);`, { mode: 0o755 });
  const mock = new MockRegistry(), report = join(f.root, "rebase.json");
  await expect(rebase({ image: `layout:${built.layout}`, oldBase: `layout:${base.directory}`, base: `layout:${base.directory}`, repo: "registry.test/app", tags: ["stable"], sign: "keyless", signIdentityToken: "token", cosignPath: f.exe, report, registry: { fetcher: mock.fetch, credentials: async () => undefined } })).rejects.toThrow("cosign");
  expect(mock.requests.some((r) => r.method === "PUT" && r.url.pathname.endsWith("/manifests/stable"))).toBe(false);
  expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({ signed: false, publication: { pendingTags: ["stable"] } });
});
