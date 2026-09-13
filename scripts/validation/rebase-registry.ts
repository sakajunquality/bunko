/** Validate rebase publication and real private signatures against a disposable local registry. */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../../packages/bunko/build.ts";
import { rebase } from "../../packages/bunko/rebase.ts";
import { verifyImage } from "../../packages/bunko/attest.ts";
import { exportMetadata } from "../../packages/bunko/metadata.ts";
import { pushLayout } from "../../packages/bunko/push-layout.ts";
import { temporary, project } from "../../test/helpers.ts";
import { rebaseBase } from "../../test/rebase-fixture.ts";
import { command } from "../../test/command.ts";

const directory = await temporary(), name = `bunko-rebase-registry-${randomUUID()}`;
const cosign = process.env.BUNKO_COSIGN_PATH ?? "cosign";
let started = false;
try {
  const version = JSON.parse(await command([cosign, "version", "--json"]));
  await command(["docker", "run", "--detach", "--name", name, "--publish", "127.0.0.1::5000", "registry:3"]); started = true;
  const info = JSON.parse(await command(["docker", "inspect", name]))[0], host = `127.0.0.1:${info.NetworkSettings.Ports["5000/tcp"][0].HostPort}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://${host}/v2/`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* Wait for the disposable registry to start. */ }
    if (attempt === 50) throw new Error("Local registry did not start"); await Bun.sleep(100);
  }
  const registry = { insecure: [host], credentials: async () => undefined };
  const old = await rebaseBase(join(directory, "old")), fresh = await rebaseBase(join(directory, "new"), undefined, { Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "FLAG=new"] });
  const oldPublished = await pushLayout(old.directory, `${host}/old`, [], registry), newPublished = await pushLayout(fresh.directory, `${host}/new`, [], registry);
  const app = await project(join(directory, "app"));
  const original = await build({ path: app, base: oldPublished.reference, repo: `${host}/app`, bare: true, push: true, registry, sbom: true, provenance: true, gitMetadata: false, localCache: false, registryCache: false });
  await rm(app, { recursive: true });
  process.env.COSIGN_PASSWORD = "";
  await mkdir(join(directory, "keys")); const key = join(directory, "keys/rebase");
  await command([cosign, "generate-key-pair", "--output-key-prefix", key]);
  const result = await rebase({ image: original.publication!.reference, oldBase: oldPublished.reference, base: newPublished.reference, repo: `${host}/rebased`, tags: ["validation"], registry, sbom: true, provenance: true, signKey: `${key}.key`, cosignPath: cosign });
  const subjects = [...new Set([result.root.digest, ...result.platforms.map((item) => item.manifest.digest), ...result.attestations.map((item) => item.manifest.digest)])];
  for (const digest of subjects) await verifyImage(`${host}/rebased@${digest}`, `${key}.pub`, true, cosign, [host]);
  const metadata = await exportMetadata(result.publication!.reference, join(directory, "metadata"), registry);
  if (metadata.records.length !== 2 || !result.signed) throw new Error("Missing rebased metadata or signatures");
  console.log(JSON.stringify({ status: "passed", cosign: version.gitVersion, original: original.root.digest, rebased: result.root.digest, verifiedSubjects: subjects, metadataArtifacts: metadata.records.length, preservedLayers: result.platforms[0]!.preservedLayers }, null, 2));
} finally {
  if (started) await command(["docker", "rm", "--force", name]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
