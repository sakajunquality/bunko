import { expect, test } from "bun:test";
import { imageSizeSummary } from "../packages/bunko/image-size.ts";

test("image sizes include every platform layer and distinguish stored bytes from expanded bytes", () => {
  const layer = (kind: string, size: number, mediaType = "application/vnd.oci.image.layer.v1.tar+gzip") => ({ kind, descriptor: { size, mediaType } });
  const output = imageSizeSummary({ os: "linux", architecture: "arm64" }, [layer("base", 68_000_000), layer("deps", 192_000_000), layer("assets", 33_000_000), layer("app", 18_000_000)]);
  expect(output).toContain("linux/arm64): 311.00 MB stored layer bytes (compressed, 4 layers)");
  expect(output).toContain("deps 192.00 MB");
  expect(imageSizeSummary({ os: "linux", architecture: "amd64" }, [layer("base", 5, "application/vnd.oci.image.layer.v1.tar")])).toContain("mixed or uncompressed");
});

import { build } from "../packages/bunko/build.ts";
import { baseLayout, project, temporary, readJSON } from "./helpers.ts";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { ImageManifest } from "../packages/oci/types.ts";

test("Docker gzip media types are compressed", () => {
  expect(imageSizeSummary({ os: "linux", architecture: "amd64" }, [{ kind: "base", descriptor: { size: 100, mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip" } }])).toContain("(compressed, 1 layers)");
});

test("build size logging includes the base and reports static capabilities", async () => {
  const root = await temporary();
  try {
    const base = await baseLayout(join(root, "base")), source = await project(join(root, "source")), output = join(root, "out");
    let log = "";
    const result = await build({ path: source, baseLayout: base, output, push: false, localCache: false, registryCache: false, gitMetadata: false, log: (text) => { log += text; } });
    const manifest = await readJSON<ImageManifest>(output, result.images[0]!.manifest);
    const total = manifest.layers.reduce((sum, layer) => sum + layer.size, 0);
    expect(log).toContain(`${(total / 1_000_000).toFixed(2)} MB stored layer bytes`);
    expect(log).toContain(`${manifest.layers.length} layers)`);
    expect(log).toContain("base ");
    expect(result.images[0]!.baseCapabilities).toMatchObject({ inspection: "static", runtimeCompatibilityVerified: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});
