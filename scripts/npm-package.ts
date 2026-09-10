import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assetNames, localAsset, releaseTag, verifyAssets } from "./distribution.ts";

export const npmPackageName = "@sakajunquality/bunko";
export const npmPackageFiles = ["package.json", "README.md", "bunko.js", "LICENSE", "THIRD_PARTY_NOTICES.md", "SHA256SUMS", "PROVENANCE.jsonl"];

/** Package previously verified release bytes; provenance verification belongs to the caller. */
export async function prepareNpmPackage(distribution: string, output: string, version: string) {
  const tag = releaseTag(version), normalized = tag.slice(1);
  // Preserve metadata when preparing an already published pre-0.2 release.
  const [major, minor] = normalized.split(/[.-]/).map(Number);
  const bunRange = major === 0 && minor! < 2 ? ">=1.3.11 <1.5" : ">=1.3.13 <1.5";
  const assets = new Map<string, Uint8Array>();
  for (const name of [...assetNames, "SHA256SUMS", "PROVENANCE.jsonl"]) assets.set(name, await localAsset(distribution, name));
  verifyAssets(Buffer.from(assets.get("SHA256SUMS")!).toString(), assets);
  if (!Buffer.from(assets.get("bunko.js")!).toString().startsWith("#!/usr/bin/env bun\n")) throw new Error("Release CLI must have a Bun shebang");
  await mkdir(output, { recursive: false });
  try {
    for (const [name, bytes] of assets) await writeFile(join(output, name), bytes, { flag: "wx" });
    await chmod(join(output, "bunko.js"), 0o755);
    const child = Bun.spawn([process.execPath, join(resolve(output), "bunko.js"), "version"], { cwd: output, env: { PATH: process.env.PATH ?? "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code) throw new Error("Release CLI version command failed");
      if (stderr) throw new Error("Release CLI version command emitted unexpected diagnostics");
      if (stdout.trim() !== normalized) throw new Error("Release CLI version does not match npm package version");
    } finally { clearTimeout(timer); }
    await writeFile(join(output, "package.json"), JSON.stringify({
      name: npmPackageName, version: normalized, description: "Build OCI images from Bun applications without Dockerfiles",
      license: "MIT", type: "module", bin: { bunko: "bunko.js" }, files: npmPackageFiles.filter((name) => name !== "package.json"),
      engines: { bun: bunRange }, os: ["linux", "darwin"], cpu: ["x64", "arm64"],
      repository: { type: "git", url: "git+https://github.com/sakajunquality/bunko.git" },
      homepage: "https://github.com/sakajunquality/bunko", bugs: "https://github.com/sakajunquality/bunko/issues",
      publishConfig: { access: "public", registry: "https://registry.npmjs.org/", tag: normalized.includes("-") ? "next" : "latest" },
    }, null, 2) + "\n", { flag: "wx" });
    await writeFile(join(output, "README.md"), `# Bunko\n\nBuild OCI images from Bun applications without Dockerfiles. Requires Bun ${bunRange} on Linux or macOS (x64 or arm64). npm installation does not install Bun.\n\n\`\`\`sh\nbunx ${npmPackageName}@${normalized} version\nbunx ${npmPackageName}@${normalized} build .\n# Or install globally (Bun must be on PATH):\nnpm install -g ${npmPackageName}@${normalized}\nbunko version\n\`\`\`\n\nThis package contains the unchanged JavaScript CLI and license files from [${tag}](https://github.com/sakajunquality/bunko/releases/tag/${tag}), plus its checksums and GitHub release provenance bundle. It has no install scripts or runtime npm dependencies. The release provenance authenticates the enclosed release assets; npm package provenance is a separate attestation of the packaging workflow.\n\nSee the [documentation](https://github.com/sakajunquality/bunko#readme), [trust boundaries](https://github.com/sakajunquality/bunko/blob/main/docs/CONFIGURATION.md), and [MIT license](LICENSE).\n`, { flag: "wx" });
    return { name: npmPackageName, version: normalized, tag: normalized.includes("-") ? "next" : "latest", directory: output };
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}

if (import.meta.main) {
  const [distribution, output, version] = process.argv.slice(2);
  if (!distribution || !output || !version) throw new Error("Usage: bun scripts/npm-package.ts RELEASE_DIRECTORY OUTPUT_DIRECTORY VERSION");
  console.log(JSON.stringify(await prepareNpmPackage(resolve(distribution), resolve(output), version)));
}
