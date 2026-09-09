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
