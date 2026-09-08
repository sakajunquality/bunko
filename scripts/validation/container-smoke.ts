import metadata from "../../package.json";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "../../test/command.ts";

const version = process.env.BUNKO_CONTAINER_VERSION ?? metadata.version;
const root = await mkdtemp(join(tmpdir(), "bunko-container-smoke-"));
const platforms = (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",");
try {
  const source = join(root, "source"); await mkdir(source);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "container-fixture", module: "index.ts", dependencies: { "is-number": "7.0.0" } }));
  await writeFile(join(source, "index.ts"), 'import isNumber from "is-number"; console.log(JSON.stringify({dependency:isNumber("123"),message:"container builder works",arch:process.arch,revision:Bun.revision}));');
  const installEnv: Record<string, string> = { HOME: root, PATH: process.env.PATH ?? "" };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
    if (process.env[key]) installEnv[key] = process.env[key]!;
  }
  const install = Bun.spawn([process.execPath, "install", "--ignore-scripts", "--lockfile-only"], { cwd: source, env: installEnv, stdout: "ignore", stderr: "pipe" });
  const installError = await new Response(install.stderr).text(); if (await install.exited) throw new Error(installError);
  const lock = Bun.JSONC.parse(await readFile(join(source, "bun.lock"), "utf8")) as Record<string, unknown>;
  if (lock.lockfileVersion !== 2) throw new Error("Container validation requires Bun 1.4 to generate a real v2 lockfile");
  for (const platform of platforms) {
    if (!["linux/amd64", "linux/arm64"].includes(platform)) throw new Error("Unsupported container validation platform");
    const architecture = platform.split("/")[1]!, image = process.env.BUNKO_CONTAINER_IMAGE ?? `bunko.local/cli-candidate:${architecture}`;
    const output = join(root, architecture); await mkdir(output); await chmod(output, 0o777);
    const config = JSON.parse(await command(["docker", "image", "inspect", image]))[0].Config;
    if (config.User !== "65532:65532") throw new Error("Builder image must default to nonroot");
    if (await command(["docker", "run", "--rm", "--platform", platform, "--network=none", "--read-only", "--cap-drop=ALL", image, "version"]) !== version) throw new Error("Unexpected container CLI version");
    await command(["docker", "run", "--rm", "--platform", platform, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev,size=2g", "--env", "XDG_CACHE_HOME=/tmp/cache", "--mount", `type=bind,source=${source},target=/work,readonly`, "--mount", `type=bind,source=${output},target=/out`, image,
      "build", "/work", "--mode", "compile", "--platform", platform, "--push=false", "--tarball", "/out/app.tar", "--report", "/out/report.json", "--no-cache", "--git-metadata=false"]);
    const report = JSON.parse(await readFile(join(output, "report.json"), "utf8"));
    if (!report.images[0].compileRuntime) throw new Error("Container compile omitted authenticated runtime input");
    const loaded = await command(["docker", "load", "--input", join(output, "app.tar")]);
    const application = /Loaded image: (.+)/.exec(loaded)?.[1]; if (!application) throw new Error("Cannot identify built application image");
    try {
      const result = JSON.parse(await command(["docker", "run", "--rm", "--platform", platform, "--network=none", "--read-only", "--cap-drop=ALL", "--user", "65532:65532", application]));
      if (result.dependency !== true || result.message !== "container builder works" || result.arch !== (architecture === "amd64" ? "x64" : "arm64") || result.revision !== report.images[0].compileRuntime.releaseRevision) throw new Error("Built application runtime mismatch");
    } finally { await command(["docker", "image", "rm", application]); }
  }
  console.log(JSON.stringify({ status: "passed", platforms, lockfileVersion: 2, builderNonroot: true, builderReadOnly: true, dockerSocket: false, signedCompileRuntime: true, applicationExecuted: true }));
} finally { await rm(root, { recursive: true, force: true }); }
