import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporary, project, baseLayout, inspectTar } from "./helpers.ts";
import { build } from "../packages/bunko/build.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { registryCredentials } from "../packages/oci/credential-sources.ts";

test.each([false, true])("selected credential files are excluded from assets and source identity (offline=%s)", async (offline) => {
  const root = await temporary();
  try {
    const source = await project(join(root, "source"), { bunko: { assets: ["public"] } });
    await mkdir(join(source, "public"));
    await writeFile(join(source, "public/message.txt"), "public");
    const config = join(source, "public/auth.json");
    await writeFile(config, JSON.stringify({ auths: { "ghcr.io": { auth: "dTpw" } } }));
    const credentials = registryCredentials(["podman"], { env: { REGISTRY_AUTH_FILE: config } });
    const options = { offline, path: source, baseLayout: await baseLayout(join(root, "base")), push: false, localCache: false, gitMetadata: false, registry: { credentials } };
    const first = await build({ ...options, output: join(root, "first") });
    const asset = first.layers.find((layer) => layer.kind === "assets")!;
    expect((await inspectTar(new BlobStore(first.layout!).path(asset.descriptor.digest))).map((entry) => entry.name)).not.toContain("app/public/auth.json");
    await writeFile(config, JSON.stringify({ auths: { "ghcr.io": { auth: "dTpyb3RhdGVk" } } }));
    expect((await build({ ...options, output: join(root, "second") })).sourceDigest).toBe(first.sourceDigest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("offline CLI still validates explicit auth sources", async () => {
  const child = Bun.spawn([process.execPath, "packages/bunko/cli.ts", "build", ".", "--offline", "--auth-source", "invalid-provider"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).not.toBe(0); expect(stdout + stderr).toContain("Auth sources");
});
