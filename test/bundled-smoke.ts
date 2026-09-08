import { baseLayout, project } from "./helpers.ts";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (import.meta.main) {
  const directory = await mkdtemp(join(tmpdir(), "bunko-bundled-"));
  try {
    const bundle = resolve("dist/bunko.js"), script = join(directory, "bunko.js");
    const text = await readFile(bundle, "utf8");
    if (!text.includes("Copyright Eemeli Aro")) throw new Error("Bundled YAML license is missing");
    if (!text.includes("Copyright Microsoft Corporation") || !text.includes("Apache License")) throw new Error("Bundled TypeScript license is missing");
    await copyFile(bundle, script);
    const input = '# bundled parser, no external node_modules\nimage: &a existing/image:tag\ncopy: *a\n';
    const child = Bun.spawn([process.execPath, script, "resolve", "-f", "-"], { cwd: directory, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH! } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0 || stdout !== input || stderr) throw new Error(`Isolated bundled CLI failed: ${exit} ${stdout} ${stderr}`);
    const inputs = join(directory, "inputs");
    await mkdir(inputs);
    await writeFile(join(inputs, "settings.json"), "{}");
    const source = await project(join(directory, "app"), { bunko: { assetMappings: [{ context: "data", from: "settings.json", to: "/repo/settings.json" }] } });
    const base = await baseLayout(join(directory, "base"));
    const build = Bun.spawn([process.execPath, script, "build", source, "--asset-context", `data=${inputs}`, "--base-layout", base, "--oci-layout", join(directory, "image"), "--push=false"], { cwd: directory, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH! } });
    const [buildOut, buildErr, buildExit] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
    if (buildExit !== 0 || buildOut) throw new Error(`Isolated bundled build failed: ${buildExit} ${buildErr}`);
    console.log("PASS: bundled resolve and guarded builds run without external npm dependencies; YAML and TypeScript licenses included");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
