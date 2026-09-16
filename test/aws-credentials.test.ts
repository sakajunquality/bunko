import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awsCredentials, ecrRegistry, ecrSignature } from "../packages/oci/aws-credentials.ts";
import { registryCredentials } from "../packages/oci/credential-sources.ts";
const host = "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com";
const staticEnv = { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "EXAMPLESECRET", AWS_SESSION_TOKEN: "SESSION" };
const expiry = () => new Date(Date.now() + 3600_000).toISOString();
const role = () => ({ AccessKeyId: "ROLEKEY", SecretAccessKey: "ROLESECRET", Token: "ROLETOKEN", Expiration: expiry() });
const ecr = (publicRegistry = false, password = "PASSWORD") => Response.json({ authorizationData: publicRegistry ? { authorizationToken: Buffer.from(`AWS:${password}`).toString("base64"), expiresAt: Date.now() / 1000 + 43200 } : [{ authorizationToken: Buffer.from(`AWS:${password}`).toString("base64"), expiresAt: Date.now() / 1000 + 43200, proxyEndpoint: `https://${host}` }] });
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function tokenFile() { const root = await mkdtemp(join(tmpdir(), "bunko-aws-test-")); roots.push(root); const actual = join(root, "actual"); await writeFile(actual, "WEBTOKEN\n"); const file = join(root, "token"); await symlink(actual, file); return file; }
test("AWS private and public host recognition excludes lookalikes, ports and partition mismatches", async () => {
  expect(ecrRegistry(host)?.region).toBe("ap-northeast-1");
  expect(ecrRegistry("123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn")?.suffix).toBe("amazonaws.com.cn");
  for (const invalid of [host + ".evil.test", host + ":8443", "123.dkr.ecr.us-east-1.amazonaws.com", "123456789012.dkr.ecr.cn-north-1.amazonaws.com", "public.ecr.aws.evil.test"]) expect(ecrRegistry(invalid)).toBeUndefined();
  expect(await awsCredentials("ghcr.io", staticEnv, { fetcher: async () => { throw new Error("Unexpected network"); } })).toBeUndefined();
});
test("static credentials sign the requested account and public ECR always uses us-east-1", async () => {
  const requests: { url: string; headers: Headers; body: string }[] = [];
  const fetcher = async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) }); return ecr(String(url).includes("ecr-public"));
  };
  expect(await awsCredentials(host, staticEnv, { fetcher })).toMatchObject({ username: "AWS", password: "PASSWORD" });
  expect(requests[0]!.body).toBe('{"registryIds":["123456789012"]}');
  expect(requests[0]!.headers.get("authorization")).toContain("/ap-northeast-1/ecr/aws4_request");
  expect(requests[0]!.headers.get("x-amz-security-token")).toBe("SESSION");
  await awsCredentials("public.ecr.aws", { ...staticEnv, AWS_REGION: "eu-west-1" }, { fetcher });
  expect(requests[1]!.url).toBe("https://api.ecr-public.us-east-1.amazonaws.com/");
  expect(requests[1]!.headers.get("authorization")).toContain("/us-east-1/ecr-public/aws4_request");
  expect(requests[1]!.headers.get("x-amz-target")).toBe("SpencerFrontendService.GetAuthorizationToken");
});
test("incomplete static identity never falls through and failures do not expose service bodies", async () => {
  let calls = 0;
  await expect(awsCredentials(host, { AWS_ACCESS_KEY_ID: "SECRET_KEY" }, { fetcher: async () => { calls++; return ecr(); } })).rejects.toThrow("AWS secret key"); expect(calls).toBe(0);
  try { await awsCredentials(host, staticEnv, { fetcher: async () => new Response("SECRET_ERROR", { status: 403 }) }); throw new Error("Expected rejection"); }
  catch (error) { expect(String(error)).toContain("HTTP 403"); expect(String(error)).not.toContain("SECRET_ERROR"); }
});
test("IRSA posts token to regional STS, supports projected token files, and refreshes rotated files", async () => {
  const file = await tokenFile(); let sts = 0;
  const provider = registryCredentials(["aws"], { env: { AWS_WEB_IDENTITY_TOKEN_FILE: file, AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/test" }, fetcher: async (url, init) => {
    if (String(url).includes("sts.")) {
      sts++; expect(init?.method).toBe("POST"); expect(String(url)).not.toContain("WEBTOKEN");
      expect(new URLSearchParams(String(init?.body)).get("WebIdentityToken")).toBe(sts === 1 ? "WEBTOKEN" : "ROTATED");
      return new Response(`<AssumeRoleWithWebIdentityResponse><Credentials><AccessKeyId>ROLEKEY</AccessKeyId><SecretAccessKey>ROLESECRET</SecretAccessKey><SessionToken>ROLETOKEN</SessionToken><Expiration>${expiry()}</Expiration></Credentials></AssumeRoleWithWebIdentityResponse>`);
    }
    expect(new Headers(init?.headers).get("authorization")).toContain("ROLEKEY/"); return ecr();
  } });
  expect(provider.sensitivePaths).toContain(file);
  await provider(host); await writeFile(file, "ROTATED"); await provider(host, true); expect(sts).toBe(2);
});
test("Pod Identity uses the allowed link-local endpoint and token file precedence", async () => {
  const file = await tokenFile();
  const env = { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials", AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: file, AWS_CONTAINER_AUTHORIZATION_TOKEN: "ignored" };
  await awsCredentials(host, env, { fetcher: async (url, init) => {
    if (String(url).includes("169.254.170.23")) { expect(new Headers(init?.headers).get("Authorization")).toBe("WEBTOKEN"); return Response.json(role()); }
    return ecr();
  } });
  await expect(awsCredentials(host, { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://attacker.test/credentials" })).rejects.toThrow("Unsafe");
  await expect(awsCredentials(host, { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "//attacker.test" })).rejects.toThrow("Invalid");
});
test("IMDS requires v2 token, rejects multiple role names, and honors disable setting", async () => {
  const calls: string[] = [];
  await awsCredentials(host, {}, { fetcher: async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("api/token")) { expect(init?.method).toBe("PUT"); return new Response("IMDSTOKEN"); }
    if (String(url).includes("169.254.169.254")) {
      expect(new Headers(init?.headers).get("X-aws-ec2-metadata-token")).toBe("IMDSTOKEN");
      return String(url).endsWith("credentials/") ? new Response("test-role\n") : Response.json(role());
    }
    return ecr();
  } }); expect(calls).toHaveLength(4);
  await expect(awsCredentials(host, { AWS_EC2_METADATA_DISABLED: "true" })).rejects.toThrow("disabled");
});
test("ECR endpoint overrides require HTTPS or loopback and response registry must match", async () => {
  await expect(awsCredentials(host, { ...staticEnv, AWS_ENDPOINT_URL_ECR: "http://attacker.test" })).rejects.toThrow("HTTPS");
  await expect(awsCredentials(host, staticEnv, { fetcher: async () => Response.json({ authorizationData: [{ proxyEndpoint: "https://other.test", authorizationToken: "SECRET" }] }) })).rejects.toThrow("requested registry");
  const result = await awsCredentials(host, { ...staticEnv, AWS_ENDPOINT_URL_ECR: "http://127.0.0.1:4566" }, { fetcher: async (url) => { expect(String(url)).toBe("http://127.0.0.1:4566/"); return ecr(); } }); expect(result?.password).toBe("PASSWORD");
});

test("ECR SigV4 matches an independently generated botocore 1.40.0 vector", () => {
  // Generated with botocore.auth.SigV4Auth canonical_request/string_to_sign/signature;
  // the fixture uses public example credentials and requires no AWS account.
  const headers = ecrSignature(new URL("https://api.ecr.ap-northeast-1.amazonaws.com/"), "ap-northeast-1", "ecr", '{"registryIds":["123456789012"]}', "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken", { accessKey: "AKIDEXAMPLE", secretKey: "EXAMPLESECRET", token: "SESSION" }, new Date("2026-09-16T00:00:00Z"));
  expect(headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260916/ap-northeast-1/ecr/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=1c4eeb1113f621599f6abdface76d081b00b45e5d26e14cea5af3c02bd45161f");
});

test("a real local ECR protocol emulator receives the signed request and refreshes credentials", async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++; expect(request.method).toBe("POST"); expect(request.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
    expect(await request.json()).toEqual({ registryIds: ["123456789012"] }); return ecr(false, `password${calls}`);
  } });
  try {
    const provider = registryCredentials(["aws"], { env: { ...staticEnv, AWS_ENDPOINT_URL_ECR: server.url.toString() } });
    expect((await provider(host))?.password).toBe("password1");
    expect((await provider(host))?.password).toBe("password1");
    expect((await provider(host, true))?.password).toBe("password2");
  } finally { server.stop(true); }
});
