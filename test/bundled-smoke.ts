import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (import.meta.main) {
  const directory = await mkdtemp(join(tmpdir(), "bunko-bundled-"));
  try {
    const bundle = resolve("dist/bunko.js"), script = join(directory, "bunko.js");
    if (!(await readFile(bundle, "utf8")).includes("Copyright Eemeli Aro")) throw new Error("Bundled YAML license is missing");
    await copyFile(bundle, script);
    const input = '# bundled parser, no external node_modules\nimage: &a existing/image:tag\ncopy: *a\n';
    const child = Bun.spawn([process.execPath, script, "resolve", "-f", "-"], { cwd: directory, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH! } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0 || stdout !== input || stderr) throw new Error(`Isolated bundled CLI failed: ${exit} ${stdout} ${stderr}`);
    console.log("PASS: bundled resolve runs without external npm dependencies; YAML license included");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
