import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { checkBase } from "../packages/bunko/check-base.ts";
import { command } from "./command.ts";

const directory = await mkdtemp(join(tmpdir(), "bunko-compile-smoke-"));
try {
  const source = join(directory, "source");
  await mkdir(source);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "compiled", module: "index.ts" }));
  await writeFile(join(source, "index.ts"), 'console.log(JSON.stringify({message:"compiled works",arch:process.arch}));');
  for (const architecture of (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",").map((p) => p.split("/")[1]!)) {
    const reference = `bunko.local/compile-${process.pid}:${architecture}`;
    const tarball = join(directory, `${architecture}.tar`);
    const result = await build({ path: source, mode: "compile", platform: `linux/${architecture}`, tarball, push: false,
      localCache: false, gitMetadata: false, verifyDeterministic: true, log: (text) => process.stderr.write(text) });
    const config = result.images[0]!;
    if (result.mode !== "compile" || !result.verifiedDeterministic || config.native.length) throw new Error("Invalid compile report");
    const loaded = await command(["docker", "load", "--input", tarball]);
    const image = /Loaded image: (.+)/.exec(loaded)?.[1];
    if (!image) throw new Error("Docker load did not return the compiled image");
    try {
      await command(["docker", "tag", image, reference]);
      const output = JSON.parse(await command(["docker", "run", "--rm", "--platform", `linux/${architecture}`, "--network=none", "--read-only", "--cap-drop=ALL", "--user=65532:65532", reference]));
      if (output.message !== "compiled works" || output.arch !== (architecture === "amd64" ? "x64" : "arm64")) throw new Error("Compiled runtime mismatch");
    } finally {
      await command(["docker", "image", "rm", reference]);
      await command(["docker", "image", "rm", image]);
    }
  }
  const base = await checkBase({ platform: process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64", run: true });
  if (base.platforms.some((p) => !p.runtimeVerified)) throw new Error("Base runtime was not verified");
  console.log("PASS: compiled images are deterministic and run on requested Linux platforms; base Bun revision verified");
} finally { await rm(directory, { recursive: true, force: true }); }
