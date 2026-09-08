import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareFontInputs } from "./font-inputs.ts";
import { command } from "../../test/command.ts";

const root = await mkdtemp(join(tmpdir(), "bunko-fonts-smoke-"));
const platforms = (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",");
try {
  const source = join(root, "source"), context = join(root, "inputs");
  await cp(resolve("examples/font-validation"), source, { recursive: true, filter: (path) => !path.split("/").includes("node_modules") });
  await prepareFontInputs(context);
  for (const mode of ["bundle", "source"]) for (const platform of platforms) {
    if (!["linux/amd64", "linux/arm64"].includes(platform)) throw new Error("Unsupported font validation platform");
    const archive = join(root, `${mode}-${platform.split("/")[1]}.tar`);
    await command([process.execPath, resolve("dist/bunko.js"), "build", source, "--mode", mode, "--platform", platform, "--asset-context", `fonts=${context}`, "--push=false", "--tarball", archive, "--git-metadata=false", "--no-cache"]);
    const loaded = await command(["docker", "load", "--input", archive]);
    const image = /Loaded image: (.+)/.exec(loaded)?.[1]; if (!image) throw new Error("Cannot identify font fixture image");
    try {
      const run = ["docker", "run", "--rm", "--platform", platform, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "65532:65532"];
      for (const recipe of ["fontconfig", "directories"]) {
        const result = JSON.parse(await command([...run, "--env", `FONT_DISCOVERY=${recipe}`, ...recipe === "directories" ? ["--env", "FONTCONFIG_FILE=/missing-fontconfig.conf"] : [], image]));
        if (result.status !== "passed" || result.recipe !== recipe || result.arch !== (platform.endsWith("amd64") ? "x64" : "arm64")) throw new Error("Font fixture failed");
        console.log(JSON.stringify({ platform, mode, ...result }));
      }
      for (const [variable, expected] of [["FONTCONFIG_FILE=/missing-fontconfig.conf", "Resvg system discovery differs"], ["DISABLE_SYSTEM_FONTS_LOAD=1", "Canvas did not discover"]]) {
        let rejected = false;
        try { await command([...run, "--env", variable!, image]); }
        catch (error) { if (!String(error).includes(expected!)) throw error; rejected = true; }
        if (!rejected) throw new Error("Missing font discovery configuration did not fail the negative control");
      }
      console.log(JSON.stringify({ platform, mode, negativeControls: "passed" }));
    } finally { await command(["docker", "image", "rm", image]); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
