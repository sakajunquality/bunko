/** Opt-in live test using an owner-authorized dedicated repository. Unique remote
 * tags/signatures are retained; only disposable local keys/files are removed. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, writeReport } from "../packages/bunko/build.ts";
import { exportMetadata } from "../packages/bunko/metadata.ts";
import { dockerCredentials } from "../packages/oci/credentials.ts";
import { verifyImage } from "../packages/bunko/attest.ts";
import { sha256 } from "../packages/oci/digest.ts";
import { BlobStore } from "../packages/oci/blob-store.ts";
import { RegistrySource } from "../packages/oci/source.ts";
import { assertFileAvailable } from "../packages/oci/archive.ts";
import { cliBuild, validateRepository, type Vendor } from "./registry-conformance.ts";
import { command } from "./command.ts";

const vendor = process.env.BUNKO_SMOKE_VENDOR as Vendor;
if (!["ghcr", "gar"].includes(vendor)) throw new Error("Set BUNKO_SMOKE_VENDOR to ghcr or gar");
const repository = validateRepository(vendor, process.env.BUNKO_SMOKE_REPO ?? "");
if (!process.env.BUNKO_SMOKE_REPORT) throw new Error("Set BUNKO_SMOKE_REPORT to a new report path");
const report = resolve(process.env.BUNKO_SMOKE_REPORT); await assertFileAvailable(report, "Report");
const cli = process.env.BUNKO_TEST_CLI ? resolve(process.env.BUNKO_TEST_CLI) : undefined;
const cliDigest = cli ? sha256(await Bun.file(cli).bytes()) : undefined;
const cosign = process.env.BUNKO_COSIGN_PATH ?? Bun.which("cosign");
if (!cosign) throw new Error("Set BUNKO_COSIGN_PATH to cosign v3.1.3");
const directory = await mkdtemp(join(tmpdir(), "bunko-supply-chain-live-")), run = randomUUID();
const password = process.env.COSIGN_PASSWORD;
process.env.COSIGN_PASSWORD = randomUUID();
let result: Awaited<ReturnType<typeof build>> | undefined;
try {
  await command([cosign, "generate-key-pair", "--output-key-prefix", join(directory, "test")]);
  const source = join(directory, "source"); await mkdir(join(source, "bunkodata"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "supply-chain-example", module: "index.ts" }));
  await writeFile(join(source, "index.ts"), 'console.log("private supply-chain conformance");');
  await writeFile(join(source, "bunkodata/message.txt"), "conventional data");
  result = cli ? await cliBuild([process.execPath, cli, "build", source, "--platform", "linux/amd64,linux/arm64", "--repo", repository, "--bare", "--tag", `supply-chain-${run}`,
    "--sbom", "--provenance", "--sign-key", join(directory, "test.key"), "--cosign-path", cosign, "--image-annotation", `example.test/run=${run}`,
    "--image-refs", join(directory, "references.txt"), "--image-label", "example.test/purpose=private-conformance", "--no-local-cache", "--no-registry-cache", "--git-metadata=false", "--verify-deterministic", "--report", join(directory, "build.json")], join(directory, "build.json"))
    : await build({ path: source, platform: "linux/amd64,linux/arm64", repo: repository, bare: true, tags: [`supply-chain-${run}`],
    sbom: true, provenance: true, signKey: join(directory, "test.key"), cosignPath: cosign,
    imageAnnotations: { "example.test/run": run }, imageRefs: join(directory, "references.txt"), imageLabels: { "example.test/purpose": "private-conformance" },
    localCache: false, registryCache: false, gitMetadata: false, verifyDeterministic: true, report: join(directory, "build.json") });
  if (cliDigest && (result.builder?.kind !== "bundle" || result.builder.digest !== cliDigest)) throw new Error("Released CLI builder fingerprint mismatch");
  if (!result.publication?.published || result.attestations?.length !== 3 || result.supplyChain?.status !== "complete") throw new Error("Incomplete supply-chain publication");
  const verified: string[] = [], store = new BlobStore(join(directory, "pull"));
  for (const descriptor of [result.root, ...result.images.map((image) => image.manifest), ...result.attestations.map((artifact) => artifact.manifest)]) {
    const reference = `${repository}@${descriptor.digest}`;
    const remote = new RegistrySource(reference), manifest = await remote.root();
    if (manifest.descriptor.digest !== descriptor.digest) throw new Error("Published digest mismatch");
    await store.put(manifest.bytes, manifest.descriptor.mediaType);
    await verifyImage(reference, join(directory, "test.pub"), true, cosign);
    verified.push(reference);
  }
  const metadata = await exportMetadata(`${repository}@${result.root.digest}`, join(directory, "metadata"), { credentials: dockerCredentials() });
  if (metadata.records.length !== 3) throw new Error("Expected two SPDX documents and one provenance statement");
  await writeReport(report, { schemaVersion: 1, vendor, status: "success", invocation: cliDigest ? { kind: "cli", digest: cliDigest } : { kind: "source" }, metadata: metadata.records, repository, root: result.root, publication: result.publication,
    attestations: result.attestations, verified, privateSignatures: true, deterministic: result.verifiedDeterministic });
  console.log(`PASS: ${vendor} OCI attachments and ${verified.length} private signatures verified; report=${report}`);
} catch (error) {
  if (!result && await Bun.file(join(directory, "build.json")).exists()) result = await Bun.file(join(directory, "build.json")).json();
  if (!await Bun.file(report).exists()) await writeReport(report, { schemaVersion: 1, vendor, status: "failed", publication: result?.publication,
    error: error instanceof Error ? error.message : "Conformance failed" });
  throw error;
} finally {
  if (password === undefined) delete process.env.COSIGN_PASSWORD; else process.env.COSIGN_PASSWORD = password;
  await rm(directory, { recursive: true, force: true });
}
