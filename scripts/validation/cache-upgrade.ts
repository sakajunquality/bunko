/** Previous-release source CLI acceptance. Requires the pinned commit in local Git
 * history and installed dependencies matching that release. Uses a loopback registry emulator; no Docker. */
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MockRegistry } from "../../test/mock-registry.ts";
import { rebaseBase } from "../../test/rebase-fixture.ts";
import { project, temporary } from "../../test/helpers.ts";

const releases: Record<string, string> = { "0.10.0": "8a8a26ad8c1b2a79ab75603dbb5109f10f18f266", "0.11.0": "9caa1c3b086be9eaea779dec525e5f5e9356920e" };
const previousVersion = process.argv[2] ?? "0.11.0", previousCommit = releases[previousVersion];
if (!previousCommit) throw new Error("Select a pinned release: 0.10.0 or 0.11.0");
const repository = resolve(import.meta.dir, "../.."), root = await temporary();
const mock = new MockRegistry();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => mock.fetch(request.url, { method: request.method, headers: request.headers, ...["GET", "HEAD"].includes(request.method) ? {} : { body: await request.bytes() } }) });
async function run(args: string[], cwd = repository, input?: Uint8Array): Promise<string> {
  const child = Bun.spawn(args, { cwd, stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH!, HOME: root, SOURCE_DATE_EPOCH: "0" } });
  if (input) { child.stdin!.write(input); child.stdin!.end(); }
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`Acceptance command failed (${code}): ${err || out}`);
  return out;
}
function assetStatuses(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(assetStatuses);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [...record.kind === "assets" && typeof record.status === "string" ? [record.status] : [], ...Object.values(record).flatMap(assetStatuses)];
}
try {
  const previous = join(root, "previous"); await mkdir(previous);
  const archive = Bun.spawn(["git", "archive", previousCommit, "packages", "package.json", "bun.lock"], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  const [bytes, error, status] = await Promise.all([new Response(archive.stdout).bytes(), new Response(archive.stderr).text(), archive.exited]);
  if (status) throw new Error(`Pinned historical source unavailable: ${error}`);
  await run(["tar", "-xf", "-", "-C", previous], repository, bytes);
  const oldPackage = JSON.parse(await readFile(join(previous, "package.json"), "utf8")), currentPackage = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  if (JSON.stringify(oldPackage.devDependencies) !== JSON.stringify(currentPackage.devDependencies)) throw new Error("Historical dependency set changed; install its exact lock before extending this acceptance fixture");
  await symlink(join(repository, "node_modules"), join(previous, "node_modules"));
  const app = await project(join(root, "app"), { bunko: { assets: ["public"] } });
  await mkdir(join(app, "public")); await writeFile(join(app, "public/data"), "shared asset\n");
  const base = (await rebaseBase(join(root, "base"))).directory, cache = join(root, "cache");
  const versions = [previous, previous, repository, repository, previous];
  const statuses: string[][] = [], imageDigests: string[] = [];
  for (const [index, source] of versions.entries()) {
    const report = join(root, "shared-report.json");
    await run([process.execPath, join(source, "packages/bunko/cli.ts"), "build", app, "--base-layout", base, "--oci-layout", join(root, `image-${index}`), "--push=false", "--cache-dir", cache, "--git-metadata=false", "--report", report], source);
    statuses.push(assetStatuses(JSON.parse(await readFile(report, "utf8"))));
    imageDigests.push(JSON.parse(await readFile(join(root, `image-${index}/index.json`), "utf8")).manifests[0].digest);
    if (index === 3) await run([process.execPath, join(repository, "packages/bunko/cli.ts"), "prune", "--cache-dir", cache, "--keep-bytes", String(Number.MAX_SAFE_INTEGER), "--execute"]);
  }
  for (const index of [1, 3, 4]) if (!statuses[index]!.includes("local")) throw new Error(`Expected warm asset cache at transition ${index}: ${JSON.stringify(statuses)}`);
  if (!statuses[2]!.includes("miss")) throw new Error("The new packing policy must not silently promote old keys");
  if (imageDigests[0] !== imageDigests[4] || imageDigests[2] !== imageDigests[3]) throw new Error("Cache upgrade or rollback changed deterministic image bytes");
  const historicalImage = `layout:${join(root, "image-0")}`;
  const baseStatus = JSON.parse(await run([process.execPath, join(repository, "packages/bunko/cli.ts"), "base-status", historicalImage, "--base-tag", `layout:${base}`, "--old-base", `layout:${base}`, "--json"]));
  const rebase = JSON.parse(await run([process.execPath, join(repository, "packages/bunko/cli.ts"), "rebase", historicalImage, "--old-base", `layout:${base}`, "--base-layout", base, "--dry-run"]));
  if (!baseStatus.results.every((item: { status: string }) => item.status === "current") || rebase.decision !== "compatible") throw new Error("Historical image was not accepted by current static rebase readers");
  const registryStatuses: string[][] = [], host = `127.0.0.1:${server.port}`;
  for (const [index, source] of versions.entries()) {
    const report = join(root, "shared-report.json");
    await run([process.execPath, join(source, "packages/bunko/cli.ts"), "build", app, "--base-layout", base, "--oci-layout", join(root, `registry-image-${index}`), "--push=false", "--cache-dir", join(root, `fresh-cache-${index}`), "--cache-repo", `${host}/cache`, "--insecure-registry", host, "--cache-export-error", "fail", "--git-metadata=false", "--report", report], source);
    registryStatuses.push(assetStatuses(JSON.parse(await readFile(report, "utf8"))));
  }
  for (const index of [1, 3, 4]) if (!registryStatuses[index]!.includes("registry")) throw new Error(`Expected warm registry asset cache at ${index}: ${JSON.stringify(registryStatuses)}`);
  console.log(JSON.stringify({ previousVersion, previousCommit, baseStatus: baseStatus.results.map((item: { status: string }) => item.status), rebase: { decision: rebase.decision, dryRun: rebase.dryRun }, reusedReportPath: true, stages: ["previous-cold", "previous-warm", "upgrade-cold", "upgrade-warm", "rollback-after-prune"], assetStatuses: statuses, imageDigests, registryStatuses, registry: "loopback Distribution emulator", containersExecuted: false }));
} finally { await server.stop(true); await rm(root, { recursive: true, force: true }); }
