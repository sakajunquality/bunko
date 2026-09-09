import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checksum } from "../distribution.ts";
import { npmPackageFiles, npmPackageName } from "../npm-package.ts";

const directory = resolve(process.argv[2] ?? "dist/npm"), destination = resolve(process.argv[3] ?? "dist/npm-artifact");
const root = await mkdtemp(join(tmpdir(), "bunko-npm-smoke-"));
const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: root, npm_config_userconfig: join(root, "npmrc"), npm_config_cache: join(root, "npm-cache"), npm_config_ignore_scripts: "true", BUN_INSTALL_CACHE_DIR: join(root, "bun-cache") };
async function run(args: string[], cwd = root) {
  const child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(`${args[0]} failed (${code}): ${err}`);
    return out.trim();
  } finally { clearTimeout(timer); }
}
try {
  await writeFile(env.npm_config_userconfig, "");
  const metadata = await Bun.file(join(directory, "package.json")).json();
  if (metadata.name !== npmPackageName) throw new Error("Unexpected npm package name");
  const packed = JSON.parse(await run(["npm", "pack", directory, "--ignore-scripts", "--json", "--pack-destination", root]))[0];
  if (JSON.stringify(packed.files.map((file: { path: string }) => file.path).sort()) !== JSON.stringify([...npmPackageFiles].sort())) throw new Error("Unexpected files in npm tarball");
  if (packed.bundled.length) throw new Error("Unexpected bundled npm dependencies");
  await mkdir(join(root, "candidate"));
  await copyFile(join(root, packed.filename), join(root, "candidate", packed.filename));
  await run(["npm", "publish", `./candidate/${packed.filename}`, "--dry-run", "--offline", "--ignore-scripts", "--json", "--access", "public", "--tag", metadata.publishConfig.tag]);
  const tarball = join(root, packed.filename), project = join(root, "project with spaces"); await mkdir(project);
  await writeFile(join(project, "package.json"), '{"name":"npm-consumer","private":true}');
  await run(["npm", "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball], project);
  const installed = join(project, "node_modules", npmPackageName, "bunko.js");
  const digest = checksum(await readFile(join(directory, "bunko.js")));
  if (checksum(await readFile(installed)) !== digest) throw new Error("Installed CLI differs from release");
  for (const args of [["npm", "exec", "--offline", "--", "bunko", "version"], [process.execPath, "x", "--no-install", "--package", npmPackageName, "bunko", "version"], [process.execPath, "x", "--no-install", npmPackageName, "version"]]) {
    if (await run(args, project) !== metadata.version) throw new Error("Installed executable version mismatch");
  }
  const yaml = join(project, "input with spaces.yaml"); await writeFile(yaml, "image: existing/example:tag\n");
  if (await run([join(project, "node_modules/.bin/bunko"), "resolve", "-f", yaml], project) !== "image: existing/example:tag") throw new Error("Executable argument forwarding failed");
  const prefix = join(root, "global");
  await run(["npm", "install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  if (await run([join(prefix, "bin/bunko"), "version"]) !== metadata.version) throw new Error("Global installation failed");
  await mkdir(destination, { recursive: false });
  await copyFile(tarball, join(destination, packed.filename));
  const report = { status: "passed", name: metadata.name, version: metadata.version, filename: packed.filename, integrity: packed.integrity, cliDigest: `sha256:${digest}`, files: packed.files.map((file: { path: string }) => file.path).sort(), publishDryRun: true, localNpmInstall: true, globalNpmInstall: true, npmExec: true, localBunx: true, argumentsContainingSpaces: true };
  await writeFile(join(destination, "validation.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await rm(root, { recursive: true, force: true }); }
