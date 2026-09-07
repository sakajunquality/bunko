import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BlobStore } from "../packages/oci/blob-store.ts";
import type { BuildResult } from "../packages/bunko/build.ts";

export async function runImage(result: BuildResult, directory: string) {
  await mkdir(directory, { recursive: true });
  const store = new BlobStore(result.layout!);
  const child = Bun.spawn(["python3", "-c", "import sys,tarfile\nfor p in sys.argv[2:]:\n with tarfile.open(p) as t:t.extractall(sys.argv[1],filter='data')", directory, ...result.layers.map((l) => store.path(l.descriptor.digest))], { stdout: "pipe", stderr: "pipe" });
  const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(error);
  const config = JSON.parse(Buffer.from(await store.read(result.config)).toString());
  const run = Bun.spawn([process.execPath, join(directory, config.config.Entrypoint[1])], { cwd: directory, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH! } });
  const [stdout, stderr, exit] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  if (exit !== 0) throw new Error(stderr);
  return stdout.trim();
}
