import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "../packages/bunko/build.ts";
import { verifyImage } from "../packages/bunko/attest.ts";
import { command } from "./command.ts";
import { baseLayout, project } from "./helpers.ts";

const cosign = process.env.BUNKO_COSIGN_PATH ?? Bun.which("cosign");
if (!cosign) throw new Error("Set BUNKO_COSIGN_PATH to cosign v3.1.3 or install it on PATH");
const directory = await mkdtemp(join(tmpdir(), "bunko-signing-smoke-"));
const container = `bunko-signing-${randomUUID()}`;
let started = false;
// Disposable test keys only. Never upload these signatures to a public log.
process.env.COSIGN_PASSWORD = randomUUID();
try {
  await command([cosign, "generate-key-pair", "--output-key-prefix", join(directory, "test")]);
  await command(["docker", "run", "--rm", "-d", "--name", container, "-p", "127.0.0.1::5000", "registry:3"]);
  started = true;
  const address = await command(["docker", "port", container, "5000/tcp"]);
  const port = address.split(":").at(-1)!;
  const host = `localhost:${port}`;
  for (let attempt = 0; ; attempt++) {
    try { const response = await fetch(`http://${host}/v2/`); if (response.ok) break; } catch { /* Wait for this test's registry. */ }
    if (attempt === 50) throw new Error("Test registry did not start");
    await Bun.sleep(100);
  }
  const source = await project(join(directory, "source")), base = await baseLayout(join(directory, "base"));
  const result = await build({ path: source, baseLayout: base, repo: `${host}/signed`, bare: true,
    sbom: true, provenance: true, signKey: join(directory, "test.key"), cosignPath: cosign,
    localCache: false, registryCache: false, gitMetadata: false,
    registry: { insecure: [host], credentials: async () => undefined } });
  if (!result.publication?.published || result.attestations?.length !== 2) throw new Error("Expected image and two attachments");
  for (const d of [result.root, result.manifest, ...result.attestations.map((a) => a.manifest)]) {
    await verifyImage(`${host}/signed@${d.digest}`, join(directory, "test.pub"), true, cosign);
  }
  console.log("PASS: Distribution 3 referrers, cosign image and attachment signatures verified without transparency-log upload");
} finally {
  if (started) await command(["docker", "rm", "--force", container]);
  await rm(directory, { recursive: true, force: true });
}
