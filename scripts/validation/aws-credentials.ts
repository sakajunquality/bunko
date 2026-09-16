/** Manual main-only acceptance of a fixed reviewed candidate. No credentials are persisted as artifacts. */
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.env.GITHUB_REPOSITORY !== "sakajunquality/bunko" || process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("AWS acceptance requires a manual main run");
const repo = process.env.BUNKO_ECR_REPOSITORY ?? "";
const match = /^(\d{12})\.dkr\.ecr\.(ap-northeast-1)\.amazonaws\.com\/bunko-validation$/.exec(repo);
const role = process.env.BUNKO_AWS_ROLE_ARN ?? "";
if (!match || role !== `arn:aws:iam::${match[1]}:role/bunko-github-ecr-validation`) throw new Error("Configure the dedicated ECR repository and matching validation role");
const mode = process.env.BUNKO_AWS_IDENTITY;
if (mode !== "web-identity" && mode !== "environment") throw new Error("Invalid identity mode");
const temporary = await mkdtemp(join(process.env.RUNNER_TEMP!, "bunko-aws-"));
const candidate = resolve("candidate");
async function module(name: string) { return import(pathToFileURL(join(candidate, "packages/oci", `${name}.ts`)).href); }
async function command(args: string[], env: Record<string, string | undefined>): Promise<string> {
  const child = Bun.spawn(args, { env, cwd: candidate, stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(`Acceptance command failed: ${args[0]} ${args[1]}`);
  return output;
}
try {
  const endpoint = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL!);
  endpoint.searchParams.set("audience", "sts.amazonaws.com");
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GitHub OIDC request failed: HTTP ${response.status}`);
  const { value: token } = await response.json() as { value: string };
  if (typeof token !== "string" || !/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error("Invalid OIDC token");
  console.log(`::add-mask::${token}`);
  const file = join(temporary, "identity.jwt");
  await writeFile(file, token, { mode: 0o600, flag: "wx" });
  // Only explicitly constructed AWS settings reach the candidate. Runner OIDC controls stay here.
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, AWS_REGION: match[2], AWS_EC2_METADATA_DISABLED: "true", AWS_CONFIG_FILE: join(temporary, "aws-config"), AWS_SHARED_CREDENTIALS_FILE: join(temporary, "aws-credentials"), DOCKER_CONFIG: join(temporary, "docker"), AWS_WEB_IDENTITY_TOKEN_FILE: file, AWS_ROLE_ARN: role, AWS_ROLE_SESSION_NAME: `bunko-${process.env.GITHUB_RUN_ID}-${mode}` };
  if (mode === "environment") {
    const result = JSON.parse(await command(["aws", "sts", "assume-role-with-web-identity", "--role-arn", role, "--role-session-name", env.AWS_ROLE_SESSION_NAME!, "--web-identity-token", `file://${file}`, "--duration-seconds", "900", "--region", match[2]!, "--output", "json"], env));
    for (const [key, value] of Object.entries({ AWS_ACCESS_KEY_ID: result.Credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: result.Credentials.SecretAccessKey, AWS_SESSION_TOKEN: result.Credentials.SessionToken })) {
      if (typeof value !== "string" || !value || /\s/.test(value)) throw new Error("Invalid STS credentials");
      console.log(`::add-mask::${value}`); env[key] = value;
    }
    delete env.AWS_WEB_IDENTITY_TOKEN_FILE; delete env.AWS_ROLE_ARN;
  }
  const { registryCredentials } = await module("credential-sources");
  const { BlobStore } = await module("blob-store");
  const { packLayer } = await module("tar");
  const { media } = await module("types");
  const { Publisher } = await module("publish");
  const { RegistrySource } = await module("source");
  let sts = 0, ecr = 0;
  const credentials = registryCredentials(["aws"], { env, fetcher: async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href === `https://sts.${match[2]}.amazonaws.com/`) sts++;
    else if (href === `https://api.ecr.${match[2]}.amazonaws.com/`) ecr++;
    else throw new Error("Unexpected AWS credential endpoint");
    return fetch(url, init);
  } });
  const host = repo.split("/")[0]!;
  await credentials(host); await credentials(host);
  if (ecr !== 1 || sts !== (mode === "web-identity" ? 1 : 0)) throw new Error("Wrong identity path or credential cache behavior");
  await credentials(host, true);
  if (Number(ecr) !== 2 || Number(sts) !== (mode === "web-identity" ? 2 : 0)) throw new Error("Credential refresh failed");
  const store = new BlobStore(join(temporary, "store"));
  const layer = await packLayer(store, [{ path: "validation.bin", type: "file", content: randomBytes(24 * 1024 * 1024) }], "app", 0);
  const config = await store.put(Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: {}, rootfs: { type: "layers", diff_ids: [layer.diffId] } })), media.config);
  const root = await store.put(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.manifest, config, layers: [layer.descriptor] })), media.manifest);
  const tag = `oidc-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${mode}`;
  const publisher = new Publisher(repo, { credentials });
  const result = await publisher.publish(store, root, [tag]);
  if (!result.published) throw new Error("Publication failed");
  const source = new RegistrySource(`${repo}:${tag}`, { credentials });
  if ((await source.root()).descriptor.digest !== root.digest) throw new Error("Published tag digest mismatch");
  const pulled = new BlobStore(join(temporary, "pulled"));
  for (const d of [config, layer.descriptor]) await pulled.putStream(await source.blob(d), d.mediaType, d);
  const again = await publisher.publish(store, root, [tag]);
  if (again.transfers.some((t: { action: string }) => t.action !== "reused")) throw new Error("Expected blob reuse");
  // Exercise the real CLI build and private-base pull with exactly the same identity path.
  const report = join(temporary, "build.json");
  await command([process.execPath, "packages/bunko/cli.ts", "build", "examples/hello", "--repo", repo, "--bare", "--platform", "linux/amd64", "--no-cache", "--auth-source", "aws", "--tag", `${tag}-app`, "--report", report], env);
  const build = await Bun.file(report).json();
  if (!build.publication?.published) throw new Error("CLI publication failed");
  await command([process.execPath, "packages/bunko/cli.ts", "check-base", "--base", build.publication.reference, "--platform", "linux/amd64", "--auth-source", "aws"], env);
  await appendFile(process.env.GITHUB_STEP_SUMMARY!, `### AWS ${mode} acceptance\n\nPassed native ECR authentication, refresh, chunked publication, digest-verified pull, blob reuse, CLI application build and private-base inspection.\n\nCandidate: \`193befbde7819e417d967a4f13ae1553cbfdad7e\`\n\nSynthetic image digest: \`${root.digest}\`\n`);
  console.log(`AWS ${mode} acceptance passed`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
