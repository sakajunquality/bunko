import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/bunko/build.ts";
import { command } from "./command.ts";

const directory = await mkdtemp(join(tmpdir(), "bunko-m6-smoke-"));
try {
  for (const platform of (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64,linux/arm64").split(",")) for (const mode of ["bundle", "compile"]) {
    const name = `bunko-m6-${randomUUID()}`, tarball = join(directory, `${mode}-${platform.split("/")[1]}.tar`);
    const result = await build({ path: resolve("examples/sqlite"), mode, platform, tarball, push: false, localCache: false, gitMetadata: false });
    const loaded = await command(["docker", "load", "--input", tarball]), image = /Loaded image: (.+)/.exec(loaded)?.[1];
    if (!image) throw new Error("Docker did not load the SQLite example");
    try {
      await command(["docker", "run", "--detach", "--name", name, "--platform", platform, "--read-only", "--tmpfs", "/tmp:rw,nosuid", "--cap-drop=ALL", "--publish", "127.0.0.1::3000", image]);
      const info = JSON.parse(await command(["docker", "inspect", name]))[0];
      const origin = `http://127.0.0.1:${info.NetworkSettings.Ports["3000/tcp"][0].HostPort}`;
      for (let attempt = 0; ; attempt++) {
        try { if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* Wait for the isolated service. */ }
        if (attempt >= 99) throw new Error("SQLite example did not become ready");
        await Bun.sleep(100);
      }
      const changed = await (await fetch(`${origin}/visits`, { method: "POST" })).json() as { count: number };
      const read = await (await fetch(`${origin}/visits`)).json() as { count: number };
      if (changed.count !== 1 || read.count !== 1) throw new Error("SQLite state did not persist between requests");
      console.log(JSON.stringify({ platform, mode, digest: result.root.digest, sqlite: "passed" }));
    } finally { await command(["docker", "rm", "--force", name]).catch(() => {}); await command(["docker", "image", "rm", image]); }
  }
} finally { await rm(directory, { recursive: true, force: true }); }
