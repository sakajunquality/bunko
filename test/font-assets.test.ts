import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetMappings, inspectAssetMappings, stageAssetMappings } from "../packages/bunko/asset-contexts.ts";
import { build } from "../packages/bunko/build.ts";
import { validateFontFile } from "../packages/bunko/font-assets.ts";
import { baseLayout, inspectTar, project, temporary } from "./helpers.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { assertBaseDataPaths } from "../packages/bunko/runtime-ca.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function sfnt(offset = 0, version = 0x10000) {
  const bytes = Buffer.alloc(72); bytes.writeUInt32BE(version, 0); bytes.writeUInt16BE(3, 4);
  for (const [index, tag] of ["head", "name", "cmap"].entries()) { bytes.write(tag, 12 + index * 16); bytes.writeUInt32BE(offset + 60 + index * 4, 20 + index * 16); bytes.writeUInt32BE(4, 24 + index * 16); }
  return bytes;
}
async function fixture() {
  const root = await temporary(); roots.push(root); const context = join(root, "context"); await mkdir(join(context, "fonts"), { recursive: true });
  await writeFile(join(context, "fonts/fixture.ttf"), sfnt()); await writeFile(join(context, "fonts/OFL.txt"), "Synthetic test font notice");
  return { root, context, mapping: { context: "fonts", from: "fonts", to: "/usr/local/share/fonts/bunko", mode: "0444" } };
}

test("font mappings package readonly fonts and notices with deterministic material identity", async () => {
  const f = await fixture(), source = await project(join(f.root, "app"), { bunko: { assetMappings: [f.mapping] } });
  const options = { path: source, baseLayout: await baseLayout(join(f.root, "base")), assetContexts: { fonts: f.context }, push: false, gitMetadata: false, cacheDir: join(f.root, "cache") };
  const first = await build({ ...options, output: join(f.root, "first"), verifyDeterministic: true });
  const layer = first.layers.find((entry) => entry.kind === "assets")!;
  const entries = await inspectTar(new BlobStore(first.layout!).path(layer.descriptor.digest));
  expect(entries.find((entry) => entry.name.endsWith("fixture.ttf"))!.mode).toBe(0o444);
  expect(entries.some((entry) => entry.name.endsWith("OFL.txt"))).toBe(true);
  const second = await build({ ...options, output: join(f.root, "second") }); expect(second.root.digest).toBe(first.root.digest);
  await writeFile(join(f.context, "fonts/OFL.txt"), "Updated synthetic notice");
  const changed = await build({ ...options, output: join(f.root, "changed") }); expect(changed.assetMaterials![0]!.digest).not.toBe(first.assetMaterials![0]!.digest);
});

test("font destinations retain reserved path, executable and symlink boundaries", async () => {
  const f = await fixture();
  for (const to of ["/usr/share/fonts-extra/font.ttf", "/usr/local/share/fonts.conf", "/usr/share/fonts/../bin/tool", "/USR/share/fonts/font.ttf", "/usr/share/fonts/node_modules/font.ttf"]) expect(() => assetMappings([{ ...f.mapping, to }])).toThrow();
  for (const mode of ["0555", "0755"]) expect(() => assetMappings([{ ...f.mapping, mode }])).toThrow("non-executable");
  await chmod(join(f.context, "fonts/fixture.ttf"), 0o755);
  await expect(stageAssetMappings([{ ...f.mapping, mode: "preserve" }], { fonts: f.context }, join(f.root, "executable"))).rejects.toThrow("non-executable");
  await chmod(join(f.context, "fonts/fixture.ttf"), 0o644);
  await symlink("fixture.ttf", join(f.context, "fonts/link.ttf"));
  await expect(stageAssetMappings([f.mapping], { fonts: f.context }, join(f.root, "linked"))).rejects.toThrow("symlinks");
  for (const parent of ["usr", "usr/local", "usr/local/share/fonts"]) expect(() => assertBaseDataPaths(new Map([[parent, { type: "symlink", mode: 0o777, size: 0, link: "elsewhere" }]]), [{ type: "file", path: "usr/local/share/fonts/bunko/font.ttf", content: sfnt() }])).toThrow("parent");
});

test("staging checks actual font data; diagnostics only inspect names, modes and sizes", async () => {
  const f = await fixture(), file = join(f.context, "fonts/fixture.ttf"); await writeFile(file, "not a font, despite the extension");
  expect((await inspectAssetMappings([f.mapping], { fonts: f.context })).entries).toBe(3);
  await expect(stageAssetMappings([f.mapping], { fonts: f.context }, join(f.root, "invalid"))).rejects.toThrow("Invalid system font");
  for (const name of ["tool.js", "fonts.conf", "payload.so"]) {
    await expect(stageAssetMappings([{ ...f.mapping, from: "fonts/OFL.txt", to: `/usr/share/fonts/${name}` }], { fonts: f.context }, join(f.root, name))).rejects.toThrow("only accept");
  }
  await writeFile(join(f.context, "fonts/OFL.txt"), Buffer.from([0xff, 0x00]));
  await expect(validateFontFile(join(f.context, "fonts/OFL.txt"), "usr/share/fonts/OFL.txt", 0o444)).rejects.toThrow("UTF-8");
});

test("SFNT and collection directory bounds reject truncated or disguised inputs", async () => {
  const f = await fixture(), file = join(f.root, "font");
  await writeFile(file, sfnt(0, 0x4f54544f)); await validateFontFile(file, "usr/share/fonts/font.otf", 0o644);
  const header = Buffer.alloc(16); header.write("ttcf"); header.writeUInt32BE(0x10000, 4); header.writeUInt32BE(1, 8); header.writeUInt32BE(16, 12);
  await writeFile(file, Buffer.concat([header, sfnt(16)])); await validateFontFile(file, "usr/share/fonts/font.ttc", 0o644);
  for (const data of [Buffer.from("\x7fELFxxxxxxxx"), sfnt().subarray(0, 20), Buffer.concat([header, sfnt(1000)])]) {
    await writeFile(file, data); await expect(validateFontFile(file, data.toString("ascii", 0, 4) === "ttcf" ? "usr/share/fonts/font.ttc" : "usr/share/fonts/font.ttf", 0o644)).rejects.toThrow("Invalid system font");
  }
});
