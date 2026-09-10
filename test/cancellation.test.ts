import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { baseLayout, project, temporary } from "./helpers.ts";

async function waitFor(check: () => Promise<boolean>, child: Bun.Subprocess) {
  const deadline = Date.now() + 8000;
  while (!await check()) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error("Child did not reach cancellation fixture barrier");
    await Bun.sleep(20);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) test(`CLI ${signal} aborts a base-layer body and removes invocation scratch`, async () => {
  const root = await temporary(); let child: Bun.Subprocess | undefined;
  const source = await project(join(root, "source")), base = await baseLayout(join(root, "base")), scratch = join(root, "scratch");
  await mkdir(scratch);
  const index = JSON.parse(await readFile(join(base, "index.json"), "utf8"));
  const descriptor = index.manifests[0], bytes = await readFile(join(base, "blobs/sha256", descriptor.digest.slice(7))), manifest = JSON.parse(bytes.toString());
  let downloading = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.includes("/manifests/")) return new Response(bytes, { headers: { "content-type": descriptor.mediaType } });
    if (path.endsWith(manifest.layers[0].digest)) {
      downloading = true;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([31, 139])); } }));
    }
    if (path.includes("/blobs/")) return new Response(await readFile(join(base, "blobs/sha256", path.split("sha256:")[1]!)));
    return new Response(null, { status: 404 });
  } });
  try {
    const host = `127.0.0.1:${server.port}`;
    child = Bun.spawn([process.execPath, resolve("packages/bunko/cli.ts"), "build", source, "--base", `${host}/base:latest`, "--insecure-registry", host, "--push=false", "--oci-layout", join(root, "output"), "--no-cache", "--no-git-metadata"], { env: { ...process.env, TMPDIR: scratch }, stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
    await waitFor(async () => downloading, child);
    expect((await readdir(scratch)).some((name) => name.startsWith("bunko-"))).toBe(true);
    child.kill(signal);
    expect(await child.exited).toBe(signal === "SIGINT" ? 130 : 143);
    expect(await stdout).toBe("");
    expect(await stderr).not.toContain("deadline reached");
    expect(await readdir(scratch)).toEqual([]);
  } finally {
    if (child?.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    server.stop(true); await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("cancellation drains a stubborn owned child before removing staged dummy credentials", async () => {
  const root = await temporary(), scratch = join(root, "scratch"), ready = join(root, "ready"), childReady = join(root, "child-ready");
  await mkdir(scratch);
  const script = `
    import {runInvocation, spawn, mkdtemp} from './packages/runtime/invocation.ts';
    const result = await runInvocation(async () => {
      const directory = await mkdtemp(${JSON.stringify(join(scratch, "owned-"))});
      await Bun.write(directory + '/.npmrc', '//registry.invalid/:_authToken=dummy-fixture-only');
      const child = spawn([process.execPath, '--eval', ${JSON.stringify(`process.on('SIGTERM', () => {}); await Bun.write(${JSON.stringify(childReady)}, 'ready'); setInterval(() => {}, 1000);`)}], {stdout:'ignore', stderr:'ignore'});
      while (!await Bun.file(${JSON.stringify(childReady)}).exists()) await Bun.sleep(10);
      await Bun.write(${JSON.stringify(ready)}, String(child.pid));
      await child.exited;
      if (!await Bun.file(directory + '/.npmrc').exists()) throw Error('Scratch removed before the child was drained');
      return 0;
    });
    process.exitCode = result;
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  try {
    await waitFor(() => Bun.file(ready).exists(), child);
    const pid = Number(await Bun.file(ready).text());
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readdir(scratch)).toEqual([]);
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
