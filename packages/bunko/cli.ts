#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { build } from "./build.ts";
import { VERSION } from "./config.ts";

const help = `bunko ${VERSION} — Bun to OCI images (M0a preview)

Usage:
  bunko build [path] --push=false --oci-layout <directory> [options]
  bunko version

Options:
  --base <reference>       Public OCI/Docker base (default: oven/bun:<Bun version>-distroless)
  --base-layout <dir>      Use a complete local OCI layout as the base
  --platform <platform>   linux/amd64 (default) or linux/arm64
  --bun-path <file>        Bun executable used for bundling
  --reproducible           Require a digest-pinned base or local base layout
  --verify-deterministic  Build twice in isolated directories and compare digests
  --git-metadata=false    Omit automatic Git labels
  --no-index              Produce a single image manifest instead of an image index
  --report <file>          Write a JSON result (outside the OCI layout)
  --help                  Show this help

M0a supports one dependency-free Bun application, assets, and OCI layout output.
Registry push, compile, npm dependencies, workspaces, and attestations are not yet supported.
Build logs go to stderr; local layout builds leave stdout empty.
`;

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgs({
      args: argv.map((arg) => arg.replace(/^--(push|git-metadata)=(true|false)$/, (_, key: string, value: string) => `--${value === "false" ? "no-" : ""}${key}`)),
      allowPositionals: true, strict: true, allowNegative: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
        push: { type: "boolean", default: true },
        "oci-layout": { type: "string" },
        "base-layout": { type: "string" },
        base: { type: "string" },
        platform: { type: "string" },
        "bun-path": { type: "string" },
        reproducible: { type: "boolean" },
        "verify-deterministic": { type: "boolean" },
        "git-metadata": { type: "boolean", default: true },
        index: { type: "boolean", default: true },
        report: { type: "string" },
      },
    });
    const { values, positionals } = parsed;
    if (values.help || !argv.length) { process.stdout.write(help); return 0; }
    const [command, path = ".", ...rest] = positionals;
    if (values.version || command === "version") { process.stdout.write(`${VERSION}\n`); return 0; }
    if (command !== "build") throw new Error(`Unknown command: ${command ?? "(missing)"}`);
    if (rest.length) throw new Error("M0a supports one build target per invocation");
    if (values.push) throw new Error("Registry push is not implemented yet; use --push=false --oci-layout <directory>");
    if (!values["oci-layout"]) throw new Error("--push=false requires --oci-layout <directory>");
    await build({
      path, output: values["oci-layout"], base: values.base,
      baseLayout: values["base-layout"], platform: values.platform,
      bunPath: values["bun-path"], report: values.report,
      reproducible: values.reproducible, verifyDeterministic: values["verify-deterministic"],
      gitMetadata: values["git-metadata"], noIndex: !values.index,
      log: (message) => process.stderr.write(message),
    });
    return 0;
  } catch (error) {
    process.stderr.write(`bunko: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
