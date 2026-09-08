import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runtimeEntries, type DependencyPlan } from "../packages/bunko/deps.ts";
import { dependencyClosure } from "../packages/bunko/closure.ts";
import { workspaceRuntime } from "../packages/bunko/workspace-runtime.ts";
import type { Project } from "../packages/bunko/config.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const platform = { os: "linux", architecture: "arm64" } as const;
const project = { targetPath: "", external: ["multi"], allowIgnoredScripts: [] } as unknown as Project;
const plan = { workspace: { packages: [{ path: "" }] } } as unknown as DependencyPlan;
const walkers = {
  production: (root: string) => runtimeEntries(root, "app", platform),
  closure: (root: string) => dependencyClosure(root, "app", platform, [project]),
  workspace: (root: string) => workspaceRuntime(root, "app", platform, plan, project),
};
function elf(machine = 183) {
  const bytes = Buffer.alloc(64); Buffer.from([127, 69, 76, 70, 2, 1]).copy(bytes);
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(machine, 18); bytes.writeUInt16LE(56, 54); return bytes;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bunko-native-addons-")); roots.push(root);
  const pkg = join(root, "node_modules/multi"); await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "multi", version: "1.0.0" }));
  await writeFile(join(pkg, "valid.node"), elf()); return { root, pkg };
}
for (const [name, walk] of Object.entries(walkers)) {
  test(`${name} omits foreign addon aliases and ignores unnamed module-scope manifests`, async () => {
    const { root, pkg } = await fixture();
    await writeFile(join(pkg, "foreign.node"), elf(62));
    await symlink("foreign.node", join(pkg, "alias.node"));
    await symlink("foreign.node", join(pkg, "alias-without-extension"));
    await symlink("valid.node", join(pkg, "valid-alias.node"));
    const freebsd = elf(); freebsd[7] = 9;
    await writeFile(join(pkg, "freebsd.node"), freebsd);
    await mkdir(join(pkg, "prebuilt-darwin"));
    await writeFile(join(pkg, "prebuilt-darwin/package.json"), '{"type":"commonjs"}');
    await writeFile(join(pkg, "prebuilt-darwin/index.node"), Buffer.from([207,250,237,254]));
    const content = await walk(root), names = content.entries.map((entry) => entry.path.split("/").at(-1));
    expect(names).toContain("valid.node"); expect(names).toContain("valid-alias.node");
    for (const omitted of ["foreign.node", "alias.node", "alias-without-extension", "index.node", "freebsd.node"]) expect(names).not.toContain(omitted);
    expect(content.omitted).toHaveLength(5);
  });
  test(`${name} rejects corrupt and unknown addon files despite a valid sibling`, async () => {
    const { root, pkg } = await fixture(), path = join(pkg, "broken.node");
    await writeFile(path, Buffer.from([127,69,76,70,2,1,0,0]));
    await expect(walk(root)).rejects.toThrow("Invalid native ELF header");
    await writeFile(path, "not a native shared library");
    await expect(walk(root)).rejects.toThrow("Unrecognized native addon format");
    const objectFile = elf(); objectFile.writeUInt16LE(1, 16);
    await writeFile(path, objectFile);
    await expect(walk(root)).rejects.toThrow("must be an ELF shared object");
  });
  test(`${name} still requires a target addon in the actual enclosing package`, async () => {
    const { root, pkg } = await fixture(); await rm(join(pkg, "valid.node"));
    await writeFile(join(pkg, "foreign.node"), elf(62));
    await expect(walk(root)).rejects.toThrow("no linux/arm64 build");
  });
}
