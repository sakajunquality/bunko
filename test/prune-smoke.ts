import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "../packages/bunko/build.ts";
import { pruneRegistry } from "../packages/bunko/prune.ts";
import { baseLayout, project } from "./helpers.ts";
import { command } from "./command.ts";

const root = await mkdtemp(join(tmpdir(), "bunko-prune-smoke-")), name = `bunko-prune-${randomUUID()}`;
let started = false;
try {
  await command(["docker", "run", "--rm", "-d", "--name", name, "-p", "127.0.0.1::5000", "-e", "REGISTRY_STORAGE_DELETE_ENABLED=true", "registry:3"]);
  started = true;
  const port = (await command(["docker", "port", name, "5000/tcp"])).split(":").at(-1)!, host = `localhost:${port}`;
  for (let i = 0; ; i++) { try { if ((await fetch(`http://${host}/v2/`)).ok) break; } catch { /* Local readiness. */ } if (i > 50) throw new Error("Registry failed to start"); await Bun.sleep(100); }
  const source = await project(join(root, "source"), { bunko: { assets: ["public"] } });
  await mkdir(join(source, "public")); await writeFile(join(source, "public/data.txt"), "cache fixture");
  const base = await baseLayout(join(root, "base")), registry = { insecure: [host], credentials: async () => undefined };
  const image = await build({ path: source, baseLayout: base, repo: `${host}/image`, bare: true, cacheRepo: `${host}/cache`, localCache: false, registry, gitMetadata: false });
  const preview = await pruneRegistry(`${host}/cache`, false, registry);
  if (preview.tags.length !== 1 || preview.deleted.length) throw new Error("Prune preview mismatch");
  let supported = true;
  try { await pruneRegistry(`${host}/cache`, true, registry); }
  catch (error) { if (!(error instanceof Error) || !error.message.includes("No manifest deletion was attempted")) throw error; supported = false; }
  const response = await fetch(`http://${host}/v2/image/manifests/${image.root.digest}`);
  if (!response.ok) throw new Error("Cache prune damaged the runnable image");
  console.log(JSON.stringify({ result: "PASS", tagDeletionSupported: supported, imageRetained: true, previewTags: preview.tags.length }));
} finally {
  if (started) await command(["docker", "rm", "--force", name]);
  await rm(root, { recursive: true, force: true });
}
