import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { loadProject, platform } from "../packages/bunko/config.ts";
import { dependencyPlan, installDependencies } from "../packages/bunko/deps.ts";
import { packDependencies } from "../packages/bunko/external-deps.ts";
import { selectToolchain } from "../packages/bunko/toolchain.ts";
import { dependencyFixture } from "./dependency-fixture.ts";
import { command } from "./command.ts";

const directory = await mkdtemp(join(tmpdir(), "bunko-operations-smoke-"));
try {
  const f = await dependencyFixture(directory), project = await loadProject({ path: f.source });
  const plan = await dependencyPlan(project, f.source), toolchain = await selectToolchain();
  for (const target of (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",")) {
    const selected = platform(target), artifact = join(directory, `deps-${selected.architecture}`);
    await installDependencies(f.source, plan, toolchain, selected, f.cache);
    await packDependencies(f.source, join(f.source, "bun.lock"), selected, artifact);
    const tarball = join(directory, `${selected.architecture}.tar`);
    await build({ path: f.source, platform: target, tarball, push: false, localCache: false, gitMetadata: false,
      installCache: f.cache, externalDeps: { [target]: `layout:${artifact}` }, verifyDeterministic: true });
    const loaded = await command(["docker", "load", "--input", tarball]), image = /Loaded image: (.+)/.exec(loaded)?.[1];
    if (!image) throw new Error("Docker did not load dependency artifact image");
    try {
      const output = await command(["docker", "run", "--rm", "--platform", target, "--read-only", "--network=none", "--cap-drop=ALL", "--user=65532:65532", image]);
      if (output !== "fixture-msg works") throw new Error("External artifact runtime mismatch");
    } finally { await command(["docker", "image", "rm", image]); }
  }
  console.log("PASS: external dependency artifacts run deterministically on requested Linux platforms");
} finally { await rm(directory, { recursive: true, force: true }); }
