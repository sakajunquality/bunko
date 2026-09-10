/** Exercise the provider harness with an authenticated, disposable Registry. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "./command.ts";
import { pullImage } from "./docker-pull.ts";
import { registryConformance } from "./registry-conformance.ts";

if (import.meta.main) {
  const directory = await mkdtemp(join(tmpdir(), "bunko-registry-auth-")), name = `bunko-registry-auth-${randomUUID()}`;
  const previous = process.env.DOCKER_CONFIG, previousOverride = process.env.BUNKO_DOCKER_CONFIG;
  let started = false;
  try {
    const auth = join(directory, "auth"), config = join(directory, "docker");
    await mkdir(auth); await mkdir(config);
    const password = randomUUID(), hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 });
    await writeFile(join(auth, "htpasswd"), `bunko:${hash}\n`, { mode: 0o600 });
    await pullImage("registry:3");
    await command(["docker", "run", "--detach", "--pull=never", "--name", name, "--publish", "127.0.0.1::5000",
      "--mount", `type=bind,src=${auth},dst=/auth,readonly`, "--env", "REGISTRY_AUTH=htpasswd",
      "--env", "REGISTRY_AUTH_HTPASSWD_REALM=bunko-conformance", "--env", "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd", "registry:3"]);
    started = true;
    const info = JSON.parse(await command(["docker", "inspect", name]))[0], host = `127.0.0.1:${info.NetworkSettings.Ports["5000/tcp"][0].HostPort}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { const response = await fetch(`http://${host}/v2/`); await response.body?.cancel(); if (response.status === 401) { ready = true; break; } } catch { /* startup */ }
      await Bun.sleep(100);
    }
    if (!ready) throw new Error("Authenticated Registry did not become ready");
    const rejected = await fetch(`http://${host}/v2/`, { headers: { Authorization: `Basic ${Buffer.from("bunko:wrong-password").toString("base64")}` } });
    await rejected.body?.cancel();
    if (rejected.status !== 401) throw new Error("Registry accepted invalid credentials");
    await writeFile(join(config, "config.json"), JSON.stringify({ auths: { [host]: { auth: Buffer.from(`bunko:${password}`).toString("base64") } } }), { mode: 0o600 });
    process.env.DOCKER_CONFIG = config; delete process.env.BUNKO_DOCKER_CONFIG;
    // CLI runs exercise the harness fallback that previously omitted --cache-repo; source runs cover a separate cache repository.
    await registryConformance({ vendor: "distribution", repo: `${host}/bunko/app`, cacheRepo: process.env.BUNKO_TEST_CLI ? undefined : `${host}/bunko/cache`,
      requireCache: true, runtimePlatforms: (process.env.BUNKO_SMOKE_PLATFORMS ?? "linux/amd64").split(","),
      report: process.env.BUNKO_SMOKE_REPORT ?? join(directory, "report.json"), installCache: process.env.BUNKO_SMOKE_NPM_CACHE,
      insecure: [host], archivePull: process.platform === "darwin" });
    console.log("PASS: anonymous and invalid credentials rejected; authenticated conformance passed");
  } finally {
    if (previous === undefined) delete process.env.DOCKER_CONFIG; else process.env.DOCKER_CONFIG = previous;
    if (previousOverride === undefined) delete process.env.BUNKO_DOCKER_CONFIG; else process.env.BUNKO_DOCKER_CONFIG = previousOverride;
    if (started) await command(["docker", "rm", "--force", name]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
