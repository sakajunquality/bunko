import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetNames, checksum } from "../scripts/distribution.ts";
import { npmPackageFiles, prepareNpmPackage } from "../scripts/npm-package.ts";

async function fixture(root: string) {
  const source = join(root, "release"); await mkdir(source);
  await writeFile(join(source, "bunko.js"), '#!/usr/bin/env bun\nconsole.log("0.1.0-rc.5");\n');
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "PROVENANCE.jsonl"]) await writeFile(join(source, name), "fixture");
  await writeFile(join(source, "SHA256SUMS"), (await Promise.all(assetNames.map(async (name) => `${checksum(await readFile(join(source, name)))}  ${name}`))).join("\n") + "\n");
  return source;
}

test("npm package preserves release bytes, excludes unrelated files and declares a Bun executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-npm-test-"));
  try {
    const source = await fixture(root), output = join(root, "package");
    await writeFile(join(source, ".npmrc"), "must not be included");
    await prepareNpmPackage(source, output, "v0.1.0-rc.5");
    expect((await readdir(output)).sort()).toEqual([...npmPackageFiles].sort());
    for (const name of [...assetNames, "SHA256SUMS", "PROVENANCE.jsonl"]) expect(await readFile(join(output, name))).toEqual(await readFile(join(source, name)));
    const metadata = await Bun.file(join(output, "package.json")).json();
    expect(metadata.bin).toEqual({ bunko: "bunko.js" }); expect(metadata.publishConfig.tag).toBe("next");
    expect(metadata.scripts).toBeUndefined(); expect(metadata.dependencies).toBeUndefined();
    await expect(prepareNpmPackage(source, output, "0.1.0-rc.5")).rejects.toThrow();
    expect(await Bun.file(join(output, "package.json")).exists()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("npm packaging rejects corrupt bytes before execution, mismatched versions and symlinked assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "bunko-npm-test-"));
  try {
    const source = await fixture(root), output = join(root, "package");
    await expect(prepareNpmPackage(source, output, "0.1.0-rc.6")).rejects.toThrow("version");
    const marker = join(root, "executed");
    await writeFile(join(source, "bunko.js"), `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)}, "bad");`);
    await expect(prepareNpmPackage(source, output, "0.1.0-rc.5")).rejects.toThrow("checksum");
    expect(await Bun.file(marker).exists()).toBe(false);
    await rm(join(source, "bunko.js")); await symlink(join(source, "LICENSE"), join(source, "bunko.js"));
    await expect(prepareNpmPackage(source, output, "0.1.0-rc.5")).rejects.toThrow("Invalid release file");
  } finally { await rm(root, { recursive: true, force: true }); }
});
