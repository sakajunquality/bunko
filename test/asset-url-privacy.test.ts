import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetURL, urlAssetFile } from "../packages/bunko/url-assets.ts";
import { stageAssetMappings } from "../packages/bunko/asset-contexts.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { provenance } from "../packages/bunko/attest.ts";
import { checkConfig } from "../packages/bunko/diagnostics.ts";
import { build } from "../packages/bunko/build.ts";
import { baseLayout, project } from "./helpers.ts";

const secret = "private-query-value";
const url = `https://assets.example/tool?token=${secret}`;
const bytes = Buffer.from("fixture"), digest = sha256(bytes).slice(7);

test("URL transport keeps the query while logs and staged materials omit it", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-url-privacy-"));
  try {
    const logs: string[] = [];
    const result = await stageAssetMappings([{ url, sha256: digest, to: "/app/tool" }], {}, join(root, "stage"), [], {
      platform: { os: "linux", architecture: "amd64" }, cache: join(root, "cache"), log: (line) => logs.push(line),
      fetcher: async (requested) => { expect(requested).toBe(url); return new Response(bytes); },
    });
    expect(result.materials[0]).toMatchObject({ url: "https://assets.example/tool", sha256: digest });
    expect(JSON.stringify(result.materials)).not.toContain(secret);
    expect(logs.join("")).toContain("https://assets.example/tool");
    expect(logs.join("")).not.toContain(secret);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("provenance removes query credentials even from caller-provided materials", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-url-provenance-"));
  try {
    const app = await project(join(root, "app")), base = await baseLayout(join(root, "base"));
    const result = await build({ path: app, baseLayout: base, push: false, output: join(root, "output"), localCache: false, registryCache: false });
    result.assetMaterials = [{ url, sha256: digest, to: "/app/tool", digest: sha256(bytes) }];
    const statement = JSON.stringify(provenance(result));
    expect(statement).toContain("https://assets.example/tool");
    expect(statement).not.toContain(secret);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid URL diagnostics never echo userinfo, queries, fragments or malformed input", () => {
  for (const value of [`https://user:${secret}@assets.example/tool`, `https://assets.example/#${secret}`, `http://assets.example/?token=${secret}`, `invalid-${secret}`]) {
    try { assetURL(value); throw new Error("expected rejection"); }
    catch (error) { expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain("expected rejection"); }
  }
});

test("download status, transport, body and redirect failures omit private URL details", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-url-errors-"));
  try {
    const responses = [
      async () => new Response(null, { status: 403 }),
      async () => { throw new Error(url); },
      async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(url)); } })),
      async () => new Response(null, { status: 302, headers: { location: `https://[${secret}` } }),
      async () => new Response("wrong checksum"),
    ];
    for (const [index, fetcher] of responses.entries()) {
      let failure: unknown;
      try { await urlAssetFile(url, digest, { cache: join(root, String(index)), destination: join(root, `file-${index}`), fetcher }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(secret);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("offline configuration reports omit query credentials without making a request", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-url-diagnostics-"));
  try {
    const app = await project(join(root, "app"), { bunko: { assetMappings: [{ url, sha256: digest, to: "/app/tool" }] } });
    const report = JSON.stringify(await checkConfig({ path: app }));
    expect(report).toContain("https://assets.example/tool");
    expect(report).not.toContain(secret);
  } finally { await rm(root, { recursive: true, force: true }); }
});
