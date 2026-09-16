import { createHash, createHmac } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { credentialJSON, credentialRequest, secret, type CredentialTransport } from "./credential-http.ts";
import type { Credential } from "./credentials.ts";

interface AwsIdentity { accessKey: string; secretKey: string; token?: string; expires?: number }
type Environment = Record<string, string | undefined>;
export function ecrRegistry(host: string) {
  if (host === "public.ecr.aws") return { public: true, region: "us-east-1", suffix: "amazonaws.com", account: undefined };
  const match = /^(\d{12})\.dkr\.ecr\.([a-z]{2}(?:-[a-z]+)+-\d)\.(amazonaws\.com(?:\.cn)?)$/.exec(host);
  if (!match || match[2]!.startsWith("cn-") !== match[3]!.endsWith(".cn")) return;
  return { public: false, region: match[2]!, suffix: match[3]!, account: match[1]! };
}
/** Projected Kubernetes token files use symlinks; validate the opened target, not the link. */
export async function credentialFile(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) throw new Error();
    const data = Buffer.alloc(256 * 1024 + 1); let offset = 0;
    while (offset < data.length) { const { bytesRead } = await file.read(data, offset, data.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    if (offset === data.length) throw new Error();
    return secret(data.subarray(0, offset).toString().trim(), "credential file");
  } catch { throw new Error("Cannot read bounded credential token file"); }
  finally { await file?.close(); }
}
function expiration(value: unknown): number {
  const result = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(result) || result <= Date.now()) throw new Error("Invalid or expired AWS credential lifetime");
  return result;
}
function identity(value: Record<string, unknown>): AwsIdentity {
  return { accessKey: secret(value.AccessKeyId), secretKey: secret(value.SecretAccessKey), token: secret(value.Token ?? value.SessionToken), expires: expiration(value.Expiration) };
}
function endpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid AWS credential endpoint"); }
  if (url.username || url.password || url.hash || url.search || /[\x00-\x20]/.test(value) || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) throw new Error("AWS API endpoints require HTTPS (HTTP is limited to local emulators)");
  return url;
}
function apiEndpoint(env: Environment, service: string, fallback: string) {
  return endpoint(env[`AWS_ENDPOINT_URL_${service}`] ?? fallback);
}
function containerEndpoint(env: Environment): URL | undefined {
  if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI !== undefined) {
    const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    if (!relative.startsWith("/") || relative.startsWith("//") || relative.includes("\\") || /[\x00-\x20#]/.test(relative)) throw new Error("Invalid AWS container credential path");
    return new URL(`http://169.254.170.2${relative}`);
  }
  if (env.AWS_CONTAINER_CREDENTIALS_FULL_URI === undefined) return;
  let url: URL;
  try { url = new URL(env.AWS_CONTAINER_CREDENTIALS_FULL_URI); } catch { throw new Error("Invalid AWS container credential endpoint"); }
  const local = ["127.0.0.1", "localhost", "[::1]", "169.254.170.2", "169.254.170.23", "[fd00:ec2::23]"].includes(url.hostname);
  if (url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol) || url.protocol === "http:" && !local) throw new Error("Unsafe AWS container credential endpoint");
  return url;
}
function xmlCredentials(text: string): Record<string, string> {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("Invalid STS credential response");
  const block = /<Credentials>([\s\S]*?)<\/Credentials>/.exec(text)?.[1];
  if (!block) throw new Error("Invalid STS credential response");
  const values: Record<string, string> = {};
  for (const field of ["AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration"]) {
    const matches = [...block.matchAll(new RegExp(`<${field}>([^<]*)</${field}>`, "g"))];
    if (matches.length !== 1) throw new Error("Invalid STS credential response");
    values[field] = matches[0]![1]!.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]!);
  }
  return values;
}
async function awsIdentity(env: Environment, region: string, suffix: string, transport: CredentialTransport): Promise<AwsIdentity> {
  if (env.AWS_ACCESS_KEY_ID !== undefined || env.AWS_SECRET_ACCESS_KEY !== undefined) return { accessKey: secret(env.AWS_ACCESS_KEY_ID, "AWS access key"), secretKey: secret(env.AWS_SECRET_ACCESS_KEY, "AWS secret key"), ...(env.AWS_SESSION_TOKEN !== undefined ? { token: secret(env.AWS_SESSION_TOKEN) } : {}) };
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE !== undefined || env.AWS_ROLE_ARN !== undefined) {
    if (!env.AWS_WEB_IDENTITY_TOKEN_FILE || !/^arn:(aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/.test(env.AWS_ROLE_ARN ?? "")) throw new Error("AWS web identity requires a token file and role ARN");
    const session = env.AWS_ROLE_SESSION_NAME ?? "bunko";
    if (!/^[A-Za-z0-9+=,.@_-]{2,64}$/.test(session)) throw new Error("Invalid AWS role session name");
    const body = new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: env.AWS_ROLE_ARN!, RoleSessionName: session, WebIdentityToken: await credentialFile(env.AWS_WEB_IDENTITY_TOKEN_FILE) });
    const url = apiEndpoint(env, "STS", `https://sts.${region}.${suffix}/`);
    const response = await credentialRequest("aws STS", url.href, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }, transport);
    return identity(xmlCredentials(response.text));
  }
  const container = containerEndpoint(env);
  if (container) {
    const token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE !== undefined ? await credentialFile(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) : env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    if (token !== undefined && (!token || /[\x00-\x1f\x7f]/.test(token))) throw new Error("Invalid AWS container authorization token");
    return identity(credentialJSON((await credentialRequest("aws container", container.href, { headers: token ? { Authorization: token } : {} }, transport, true)).text));
  }
  if (env.AWS_PROFILE !== undefined || env.AWS_DEFAULT_PROFILE !== undefined) throw new Error("AWS profiles and SSO require a Docker credential helper");
  if (env.AWS_EC2_METADATA_DISABLED?.toLowerCase() === "true") throw new Error("AWS identity unavailable; metadata is disabled");
  const base = "http://169.254.169.254/latest/";
  const token = secret((await credentialRequest("aws IMDSv2", `${base}api/token`, { method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" } }, transport, true)).text);
  const headers = { "X-aws-ec2-metadata-token": token };
  const role = (await credentialRequest("aws IMDSv2", `${base}meta-data/iam/security-credentials/`, { headers }, transport, true)).text.trim();
  if (!/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(role)) throw new Error("Invalid AWS metadata role response");
  return identity(credentialJSON((await credentialRequest("aws IMDSv2", `${base}meta-data/iam/security-credentials/${encodeURIComponent(role)}`, { headers }, transport, true)).text));
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Uint8Array, value: string) => createHmac("sha256", key).update(value).digest();
/** Sign the bounded JSON ECR authorization request; this is not a general AWS client. */
export function ecrSignature(url: URL, region: string, service: string, body: string, target: string, credentials: AwsIdentity, date = new Date()): Record<string, string> {
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/g, ""), day = timestamp.slice(0, 8);
  const headers: Record<string, string> = { "content-type": "application/x-amz-json-1.1", host: url.host, "x-amz-date": timestamp, "x-amz-target": target, ...(credentials.token ? { "x-amz-security-token": credentials.token } : {}) };
  const names = Object.keys(headers).sort(), scope = `${day}/${region}/${service}/aws4_request`;
  const canonical = ["POST", url.pathname.split("/").map((part) => encodeURIComponent(decodeURIComponent(part)).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)).join("/"), "", names.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, " ")}\n`).join(""), names.join(";"), hash(body)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretKey}`, day), region), service), "aws4_request");
  const signature = hmac(key, `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).toString("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return headers;
}
export async function awsCredentials(host: string, env: Environment, transport: CredentialTransport = {}): Promise<Credential | undefined> {
  const registry = ecrRegistry(host); if (!registry) return;
  const credentials = await awsIdentity(env, registry.region, registry.suffix, transport);
  const service = registry.public ? "ecr-public" : "ecr";
  const url = apiEndpoint(env, registry.public ? "ECR_PUBLIC" : "ECR", `https://api.${service}.${registry.region}.${registry.suffix}/`);
  const body = registry.public ? "{}" : JSON.stringify({ registryIds: [registry.account] });
  const target = registry.public ? "SpencerFrontendService.GetAuthorizationToken" : "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken";
  const data = credentialJSON((await credentialRequest("aws ECR", url.href, { method: "POST", body, headers: ecrSignature(url, registry.region, service, body, target, credentials) }, transport)).text);
  const entry = registry.public ? data.authorizationData : Array.isArray(data.authorizationData) ? data.authorizationData.find((entry: any) => entry?.proxyEndpoint === `https://${host}`) : undefined;
  if (!entry || typeof entry !== "object") throw new Error("AWS ECR returned no authorization for the requested registry");
  const auth = entry as Record<string, unknown>, encoded = secret(auth.authorizationToken);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Invalid ECR authorization encoding");
  const decoded = Buffer.from(encoded, "base64").toString();
  if (!decoded.startsWith("AWS:")) throw new Error("Invalid ECR authorization identity");
  return { username: "AWS", password: secret(decoded.slice(4)), expires: Math.min(expiration(auth.expiresAt), credentials.expires ?? Infinity) };
}
