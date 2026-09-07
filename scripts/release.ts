import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import metadata from "../package.json";
import { assetNames, checksum, releaseTag, verifyAssets } from "./distribution.ts";

export async function prepareRelease(output = resolve("dist/release"), tag = `v${metadata.version}`) {
  if (releaseTag(tag) !== `v${metadata.version}`) throw new Error("Release tag must match package.json version");
  // Refuse to reuse an existing destination, including empty directories.
  await mkdir(output, { recursive: false });
  try {
    const result = await Bun.build({ entrypoints: [fileURLToPath(new URL("../packages/bunko/cli.ts", import.meta.url))], target: "bun", naming: "bunko.js", outdir: output, minify: true });
    if (!result.success) throw new Error("Release bundle failed");
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
      await copyFile(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(output, name));
    }
    const assets = new Map<string, Uint8Array>();
    for (const name of assetNames) assets.set(name, await readFile(join(output, name)));
    const hashes = assetNames.map((name) => `${checksum(assets.get(name)!)}  ${name}`).join("\n") + "\n";
    await writeFile(join(output, "SHA256SUMS"), hashes, { flag: "wx" });
    verifyAssets(hashes, assets);
    const child = Bun.spawn([process.execPath, join(output, "bunko.js"), "version"], { cwd: output, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code || stderr || stdout.trim() !== metadata.version) throw new Error("Release CLI version does not match package.json");
    return { version: metadata.version, tag: `v${metadata.version}`, directory: output };
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}

if (import.meta.main) {
  const output = resolve(process.argv[2] ?? "dist/release");
  await mkdir(resolve(output, ".."), { recursive: true });
  console.log(JSON.stringify(await prepareRelease(output, process.env.BUNKO_RELEASE_TAG)));
}
