import { join } from "node:path";
import { VERSION, loadProject, type BuildOptions } from "./config.ts";
import { dependencyPlan } from "./deps.ts";
import { discover } from "./workspace.ts";
import { selectToolchain } from "./toolchain.ts";

/** Offline configuration diagnostics. Never expose env, define or npmrc values. */
export async function checkConfig(options: BuildOptions) {
  const discovery = await discover(options);
  const projects = [];
  for (const target of discovery.targets) {
    const project = await loadProject({ ...options, path: join(discovery.directory, target.path) }, discovery.workspace);
    await dependencyPlan(project, discovery.directory, false);
    projects.push({ name: project.name, path: target.path || ".", entrypoint: project.entrypoint, mode: project.mode,
      platforms: project.platforms, dependencyStrategy: project.depsStrategy, external: project.external,
      workdir: project.workdir, runtimePath: project.bunPath, assets: project.assets,
      environmentKeys: Object.keys(project.env).sort(), defineKeys: Object.keys(project.build.define).sort() });
  }
  if (new Set(projects.map((project) => project.name)).size !== projects.length) throw new Error("Selected targets have an image name collision");
  return { schemaVersion: 1, status: "valid", bunko: VERSION, workspace: Boolean(discovery.workspace), targets: projects,
    unchecked: ["source syntax and bundling", "dependency installation and native compatibility", "base image runtime", "registry credentials and connectivity"] };
}

export async function doctor(options: BuildOptions) {
  const config = await checkConfig(options), toolchain = await selectToolchain(options.bunPath);
  return { ...config, toolchain: { version: toolchain.version, revision: toolchain.revision },
    host: { os: process.platform, architecture: process.arch, runtime: Bun.version },
    optionalTools: Object.fromEntries(["docker", "kubectl", "cosign"].map((name) => [name, Boolean(Bun.which(name === "cosign" ? options.cosignPath ?? name : name))])),
    advice: ["Use check-base --run to verify a base in Docker.", "Use build --push=false --oci-layout DIR for a complete local build check."] };
}
