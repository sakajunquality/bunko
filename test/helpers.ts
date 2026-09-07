import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { canonicalJSON } from "../packages/oci/digest.ts";
import { media, type Descriptor, type ImageConfig, type Platform } from "../packages/oci/types.ts";
import { packLayer } from "../packages/oci/tar.ts";

export async function temporary(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bunko-test-"));
}

export async function project(root: string, extra: Record<string, unknown> = {}, source = 'console.log("hello bunko");\n'): Promise<string> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "hello", module: "src/server.ts", type: "module", ...extra }));
  await writeFile(join(root, "src/server.ts"), source);
  return root;
}

export async function baseLayout(root: string, platform: Platform = { os: "linux", architecture: "amd64" }): Promise<string> {
  const store = new BlobStore(root);
  const layer = (await packLayer(store, [{ path: "base-marker", type: "file", content: Buffer.from("base contents\n") }], "assets", 0))!;
  const config: ImageConfig = {
    ...platform,
    config: {
      User: "65532:65532", Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "BASE_FLAG=retained"],
      Entrypoint: ["old-entry"], Cmd: ["old-argument"], WorkingDir: "/old-workdir",
      Labels: { "base.label": "retained" }, StopSignal: "SIGTERM",
    },
    rootfs: { type: "layers", diff_ids: [layer.diffId] },
    history: [{ created_by: "base fixture" }, { created_by: "ENV BASE_FLAG", empty_layer: true }],
  };
  const c = await store.put(canonicalJSON(config), media.config);
  const manifest = await store.put(canonicalJSON({ schemaVersion: 2, mediaType: media.manifest, config: c, layers: [layer.descriptor] }), media.manifest);
  await writeFile(join(root, "oci-layout"), canonicalJSON({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(root, "index.json"), canonicalJSON({ schemaVersion: 2, mediaType: media.index, manifests: [{ ...manifest, platform }] }));
  return root;
}

export async function readJSON<T>(root: string, descriptor: Descriptor): Promise<T> {
  return JSON.parse(Buffer.from(await new BlobStore(root).read(descriptor)).toString());
}

export async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, resolve("packages/bunko/cli.ts"), "--no-local-cache", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

/** Uses Python's independent tar implementation, including PAX handling. */
export async function inspectTar(path: string): Promise<{ name: string; mode: number; uid: number; gid: number; mtime: number; linkname: string; content: string | null }[]> {
  const script = `import tarfile,json,sys
with tarfile.open(sys.argv[1], 'r:gz') as archive:
 print(json.dumps([dict(name=m.name,mode=m.mode,uid=m.uid,gid=m.gid,mtime=m.mtime,linkname=m.linkname,content=archive.extractfile(m).read().decode() if m.isfile() else None) for m in archive]))`;
  const child = Bun.spawn(["python3", "-c", script, path], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit) throw new Error(`tar interoperability check failed: ${stderr}`);
  return JSON.parse(stdout);
}
