import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BuildResult } from "../../packages/bunko/build.ts";
import { BlobStore } from "../../packages/oci/blob-store.ts";
import { canonicalJSON } from "../../packages/oci/digest.ts";
import { packLayer } from "../../packages/oci/tar.ts";
import { media } from "../../packages/oci/types.ts";
import { mkdtemp, runInvocation } from "../../packages/runtime/invocation.ts";
import { baseLayout, inspectTar, project } from "../../test/helpers.ts";
import { MockRegistry } from "../../test/mock-registry.ts";
import { checked } from "./acceptance-command.ts";

process.exitCode = await runInvocation(async () => {
  assert.equal(process.platform, "linux", "Cross-device acceptance requires Linux; it must not silently skip");
  const root = await mkdtemp(join(tmpdir(), "bunko-cross-device-"));
  let cache: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    cache = await mkdtemp(join(process.env.BUNKO_CROSS_DEVICE_CACHE_ROOT ?? "/dev/shm", "bunko-asset-cache-"));
    const devices = { work: (await stat(root)).dev, cache: (await stat(cache)).dev };
    assert.notEqual(devices.work, devices.cache, "Work and asset cache must be on distinct filesystems");
    const scratch = join(root, "scratch"); await mkdir(scratch);
    const platform = { os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64" } as const;
    const base = await baseLayout(join(root, "base"), platform);
    const store = new BlobStore(join(root, "donor"));
    const layer = (await packLayer(store, [
      { path: "opt/tool/bin/run", type: "file", content: Buffer.from("executable asset\n"), executable: true },
      { path: "opt/tool/data/value.json", type: "file", content: Buffer.from('{"value":42}\n') },
    ], "assets", 0))!;
    const config = await store.put(canonicalJSON({ ...platform, config: {}, rootfs: { type: "layers", diff_ids: [layer.diffId] } }), media.config);
    const manifest = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, config, layers: [layer.descriptor] }), media.manifest);
    const registry = new MockRegistry();
    // A real loopback HTTP endpoint lets the bundled CLI exercise registry reads in a child process.
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => registry.fetch(request.url, { method: request.method, headers: request.headers }) });
    const host = `127.0.0.1:${server.port}`, repository = `${host}/fixture/tool`;
    registry.manifests.set(`${repository}/${manifest.digest}`, { bytes: await store.read(manifest), type: media.manifest });
    for (const descriptor of [config, layer.descriptor]) registry.blobs.set(`${repository}/${descriptor.digest}`, await store.read(descriptor));
    const source = await project(join(root, "source"), { bunko: { assetMappings: [
      { image: `${repository}@${manifest.digest}`, from: "/opt/tool/bin/run", to: "/tools/single" },
      { image: `${repository}@${manifest.digest}`, from: "/opt/tool", to: "/tools/tree" },
    ] } });
    const results: { phase: string; manifest: string; blobReads: number }[] = [];
    for (const phase of ["cold", "warm"]) {
      const output = join(root, phase), report = join(root, `${phase}.json`), start = registry.requests.length;
      await checked([process.execPath, resolve("dist/bunko.js"), "build", source,
        "--bun-path", process.execPath, "--base-layout", base, "--platform", `linux/${platform.architecture}`, "--insecure-registry", host,
        "--asset-cache", cache, "--cache-dir", join(root, `${phase}-layers`), "--install-cache", join(root, "install"),
        "--no-registry-cache", "--oci-layout", output, "--report", report, "--push=false", "--git-metadata=false"],
      { env: { ...process.env, TMPDIR: scratch, SOURCE_DATE_EPOCH: "0" } });
      const built = JSON.parse(await readFile(report, "utf8")) as BuildResult;
      const assets = built.images[0]!.layers.find((item) => item.kind === "assets");
      assert.ok(assets, "Missing asset layer");
      const entries = await inspectTar(new BlobStore(output).path(assets.descriptor.digest));
      for (const [name, mode, content] of [
        ["tools/single", 0o755, "executable asset\n"],
        ["tools/tree/bin/run", 0o755, "executable asset\n"],
        ["tools/tree/data/value.json", 0o644, '{"value":42}\n'],
      ] as const) {
        const entry = entries.find((entry) => entry.name === name);
        assert.ok(entry, `Missing ${name}`); assert.equal(entry.mode, mode); assert.equal(entry.content, content);
      }
      const blobReads = registry.requests.slice(start).filter((request) => request.method === "GET" && request.url.pathname.endsWith(`/blobs/${layer.descriptor.digest}`)).length;
      if (phase === "cold") assert.ok(blobReads > 0, "Cold build did not fetch donor bytes");
      else {
        assert.equal(blobReads, 0, "Warm asset cache fetched the donor layer again");
        assert.equal(built.images[0]!.manifest.digest, results[0]!.manifest, "Warm build changed image bytes");
      }
      results.push({ phase, manifest: built.images[0]!.manifest.digest, blobReads });
    }
    const result = { schemaVersion: 1, status: "passed", devices, platform, checks: results };
    console.log(JSON.stringify(result));
    if (process.env.BUNKO_SMOKE_REPORT) await writeFile(process.env.BUNKO_SMOKE_REPORT, JSON.stringify(result, null, 2) + "\n");
    return 0;
  } finally {
    server?.stop(true);
    if (cache) await rm(cache, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
