import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitLabels, sourceURL } from "../packages/bunko/source-metadata.ts";
import { temporary } from "./helpers.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test.each([
  ["https://user:SECRET@github.com/example/service.git?token=SECRET#SECRET", "https://github.com/example/service"],
  ["git@github.com:example/service.git", "https://github.com/example/service"],
  ["ssh://git:SECRET@git.example:2222/example/service.git", "https://git.example/example/service"],
  ["git://git.example:9418/example/service.git", "https://git.example/example/service"],
  ["https://git.example:8443/example/service.git/", "https://git.example:8443/example/service"],
  ["C:/local/checkout", undefined], ["c:relative/checkout", undefined], ["/local/checkout", undefined], ["file:///local/checkout", undefined], ["C:\\local\\checkout", undefined],
  ["https://git.example/example/line\nbreak", undefined],
])("source remote %s normalizes without credential state", (input, expected) => {
  expect(sourceURL(input!)).toBe(expected);
});

test("failed Git status never claims a clean tree or prints raw diagnostics", async () => {
  const root = await temporary(); roots.push(root); await mkdir(join(root, ".git"));
  const executable = join(root, "git-fixture"), warnings: string[] = [];
  await writeFile(executable, `#!${process.execPath}\nconst args=process.argv.slice(2); if(args.includes('rev-parse')) console.log('${"a".repeat(40)}'); else if(args.includes('status')) { console.error('SECRET_DIAGNOSTIC'); process.exit(1); } else console.log('https://user:SECRET_TOKEN@git.example/example/service.git?token=SECRET_TOKEN');`, { mode: 0o755 });
  const labels = await gitLabels(root, (message) => warnings.push(message), executable);
  expect(labels["org.opencontainers.image.revision"]).toBe("a".repeat(40));
  expect(labels["org.bunko.git.dirty"]).toBeUndefined();
  expect(labels["org.opencontainers.image.source"]).toBe("https://git.example/example/service");
  expect(warnings).toHaveLength(1); expect(warnings[0]).toContain("safe.directory");
  expect(JSON.stringify({ labels, warnings })).not.toContain("SECRET");
  expect(await gitLabels(root, (message) => warnings.push(message), null)).toEqual({});
  expect(warnings).toHaveLength(2);
});

test("a broken checkout reports optional Git metadata failure without exposing its path", async () => {
  const root = await temporary(); roots.push(root); await mkdir(join(root, ".git"));
  const warnings: string[] = [];
  expect(await gitLabels(root, (message) => warnings.push(message))).toEqual({});
  expect(warnings).toHaveLength(1); expect(warnings.join("")).not.toContain(root);
  await rm(join(root, ".git"), { recursive: true });
  expect(await gitLabels(root, (message) => warnings.push(message))).toEqual({});
  expect(warnings).toHaveLength(1);
});

test("repository fsmonitor commands cannot execute during metadata collection", async () => {
  const root = await temporary(); roots.push(root);
  const git = async (...args: string[]) => { const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" }); if (await child.exited) throw new Error(await new Response(child.stderr).text()); };
  await git("init"); await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  const marker = join(root, "executed"); const hook = join(root, "monitor");
  await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  await git("config", "core.fsmonitor", hook);
  expect((await gitLabels(root))["org.opencontainers.image.revision"]).toMatch(/^[a-f0-9]{40}$/);
  expect(await Bun.file(marker).exists()).toBe(false);
});


test.each(["clean", "process"])("repository %s filters cannot execute during metadata collection", async (kind) => {
  const root = await temporary(); roots.push(root);
  const git = async (...args: string[]) => { const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" }); const output = await new Response(child.stdout).text(); if (await child.exited) throw new Error(await new Response(child.stderr).text()); return output.trim(); };
  await git("init");
  await writeFile(join(root, ".gitattributes"), "tracked filter=attack\n");
  await writeFile(join(root, "tracked"), "initial\n");
  await git("add", ".");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  const marker = join(root, "executed");
  await git("config", `filter.attack.${kind}`, `touch '${marker}'; cat`);
  await writeFile(join(root, "tracked"), "changed\n");
  const warnings: string[] = [];
  const labels = await gitLabels(root, (message) => warnings.push(message));
  expect(labels["org.opencontainers.image.revision"]).toMatch(/^[a-f0-9]{40}$/);
  expect(labels["org.bunko.git.dirty"]).toBeUndefined();
  expect(warnings).toHaveLength(1);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test.each([".", "app"])("gitlinks omit dirty metadata from %s without inspecting sibling submodules", async (subdirectory) => {
  const root = await temporary(); roots.push(root);
  const git = async (...args: string[]) => { const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" }); const output = await new Response(child.stdout).text(); if (await child.exited) throw new Error(await new Response(child.stderr).text()); return output.trim(); };
  await git("init");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  await mkdir(join(root, "app"));
  const revision = await git("rev-parse", "HEAD");
  await git("update-index", "--add", "--cacheinfo", `160000,${revision},submodule`);
  const warnings: string[] = [];
  const labels = await gitLabels(join(root, subdirectory), (message) => warnings.push(message));
  expect(labels["org.opencontainers.image.revision"]).toBe(revision);
  expect(labels["org.bunko.git.dirty"]).toBeUndefined();
  expect(warnings).toHaveLength(1);
});
