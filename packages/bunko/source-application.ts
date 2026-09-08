import { posix } from "node:path";
import type { Project } from "./config.ts";
import type { bundle } from "./toolchain.ts";

/** Preserve the complete sanitized source snapshot and its module-relative paths. */
export async function sourceApplication(project: Project, root: string): Promise<Awaited<ReturnType<typeof bundle>>> {
  const entry = posix.join(project.targetPath, project.entrypoint);
  const entrypoints = project.entrypoints ? Object.fromEntries(Object.entries(project.entrypoints).map(([name, path]) => [name, posix.join(project.targetPath, path)])) : undefined;
  return { outdir: root, entry, entrypoints, inventory: [], locations: { total: 0, warnings: [] }, inputs: [] };
}
