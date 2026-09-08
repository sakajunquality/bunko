import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetNames, releaseTag, verifyAssets } from "../scripts/distribution.ts";
import { prepareRelease } from "../scripts/release.ts";
import { githubBytes, setup } from "../scripts/setup.ts";
import metadata from "../package.json";
import { baseLayout, project, temporary } from "./helpers.ts";

let root: string, distribution: string;
beforeAll(async () => { root = await temporary(); distribution = join(root, "release"); await prepareRelease(distribution); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("release assets carry matching versions, checksums, and parser licenses", async () => {
  const assets = new Map<string, Uint8Array>();
  for (const name of assetNames) assets.set(name, await readFile(join(distribution, name)));
  verifyAssets(await readFile(join(distribution, "SHA256SUMS"), "utf8"), assets);
  const bundle = Buffer.from(assets.get("bunko.js")!).toString();
  expect(bundle).toContain("Copyright Eemeli Aro"); expect(bundle).toContain("Copyright Microsoft Corporation"); expect(bundle).toContain("Apache License");
  const license = await readFile("LICENSE", "utf8");
  expect(bundle).toContain(license.trim());
  expect(Buffer.from(assets.get("LICENSE")!).toString()).toBe(license);
  const notices = Buffer.from(assets.get("THIRD_PARTY_NOTICES.md")!).toString();
  const typescriptNotices = (await readFile("node_modules/typescript/ThirdPartyNoticeText.txt", "utf8")).replaceAll("\r\n", "\n").replace(/[ \t]+$/gm, "");
  expect(notices).toContain(typescriptNotices.trim());
  expect(bundle).toContain("Copyright (c) 1991-2017 Unicode, Inc.");
  await expect(prepareRelease(distribution)).rejects.toThrow();
  await expect(prepareRelease(join(root, "wrong-tag"), "v9.9.9")).rejects.toThrow("must match");
});

test("offline installation runs outside node_modules and handles quoted paths and arguments", async () => {
  const prefix = join(root, "space and ' quote"); await mkdir(prefix);
  const installed = await setup({ version: metadata.version, distribution, temporary: prefix });
  expect(installed.version).toBe(metadata.version);
  const child = Bun.spawn([installed.executable, "version"], { cwd: prefix, stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
  expect(await new Response(child.stdout).text()).toBe(`${metadata.version}\n`); expect(await child.exited).toBe(0);
  const input = join(prefix, "file ' with spaces.yaml"); await writeFile(input, "image: existing/app:tag\n");
  const resolve = Bun.spawn([installed.executable, "resolve", "-f", input], { cwd: prefix, stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
  expect(await new Response(resolve.stdout).text()).toBe("image: existing/app:tag\n"); expect(await resolve.exited).toBe(0);
});

test("minified distribution rejects macros before executing source", async () => {
  const marker = join(root, "macro-executed");
  const source = await project(join(root, "macro-project"), {}, 'import value from "./macro.ts" with { type: "macro" }; console.log(value());');
  await writeFile(join(source, "src/macro.ts"), `export default async function value() { await Bun.write(${JSON.stringify(marker)}, "executed"); return 1; }`);
  const base = await baseLayout(join(root, "macro-base"));
  const child = Bun.spawn([process.execPath, join(distribution, "bunko.js"), "build", source, "--base-layout", base, "--push=false", "--oci-layout", join(root, "macro-output")],
    { cwd: root, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(1); expect(stdout).toBe(""); expect(stderr).toContain("macros are not supported");
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("corrupted artifacts are rejected before execution or installation", async () => {
  const corrupt = join(root, "corrupt"); await cp(distribution, corrupt, { recursive: true });
  const marker = join(root, "executed");
  await writeFile(join(corrupt, "bunko.js"), `await Bun.write(${JSON.stringify(marker)}, "unsafe");`);
  await expect(setup({ version: metadata.version, distribution: corrupt, temporary: root })).rejects.toThrow("checksum mismatch");
  expect(await Bun.file(marker).exists()).toBe(false);
  const manifest = await readFile(join(distribution, "SHA256SUMS"), "utf8");
  expect(() => verifyAssets(manifest + manifest, new Map())).toThrow("duplicate");
  expect(() => verifyAssets(`${"a".repeat(64)}  ../outside\n`, new Map())).toThrow("Invalid");
});

test("a checksummed artifact must still report the requested release version", async () => {
  await expect(setup({ version: "v9.9.9", distribution, temporary: root })).rejects.toThrow("version does not match");
  expect(() => releaseTag("latest")).toThrow("explicit");
  expect(() => releaseTag("v1.0.0\ninvalid")).toThrow();
  expect(releaseTag("0.1.0-alpha.2")).toBe("v0.1.0-alpha.2");
});

test("private release assets use authenticated API downloads and strip tokens on storage redirects", async () => {
  const names = ["SHA256SUMS", ...assetNames], token = "test-only-private-token", seen: string[] = [];
  const installed = await setup({ version: metadata.version, repository: "SakaJunQuality/Bunko", token, temporary: root, fetcher: (async (input, init) => {
    const url = new URL(input), headers = new Headers(init?.headers); seen.push(url.toString());
    expect(url.toString()).not.toContain(token);
    if (url.hostname === "storage.example") {
      expect(headers.has("Authorization")).toBe(false);
      return new Response(await readFile(join(distribution, names[Number(url.pathname.slice(1))]!)));
    }
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
    if (url.pathname.includes("/tags/")) return Response.json({ tag_name: `v${metadata.version}`, draft: false, assets: names.map((name, id) => ({ name, url: `https://api.github.com/repos/sakajunquality/bunko/releases/assets/${id}` })) });
    expect(headers.get("Accept")).toBe("application/octet-stream");
    return new Response(null, { status: 302, headers: { Location: `https://storage.example/${url.pathname.split("/").at(-1)}` } });
  }) });
  expect(installed.version).toBe(metadata.version); expect(seen).toHaveLength(9);
});

test("failed downloads redact credentials and reject insecure redirect targets", async () => {
  await expect(githubBytes(new URL("https://api.github.com/repos/owner/repo"), "secret", "application/json", (async () => new Response(null, { status: 404 })))).rejects.toThrow("404");
  await expect(githubBytes(new URL("https://api.github.com/repos/owner/repo"), "secret", "application/json", (async () => new Response(null, { status: 302, headers: { Location: "http://storage.example/asset" } })))).rejects.toThrow("Invalid release download URL");
});
