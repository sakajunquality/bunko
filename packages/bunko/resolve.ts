import { labelSelector, selectDocuments } from "./selector.ts";
import { referenceOutput, writeReferences } from "./references.ts";
/*! yaml 2.9.0 — https://github.com/eemeli/yaml
Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
*/
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, join, resolve as absolute } from "node:path";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Node } from "yaml";
import { assertFileAvailable } from "../oci/archive.ts";
import { canonicalOutput } from "../oci/layout.ts";
import { repository, repositoryName } from "../oci/publish.ts";
import { prepareTargets, writeReport, type BuildResult, type PreparedTargets } from "./build.ts";
import { loadProject, type BuildOptions } from "./config.ts";
import { discover } from "./workspace.ts";

export interface ResolveOptions extends Omit<BuildOptions, "path"> {
  files: string[];
  context?: string;
  recursive?: boolean;
  selector?: string;
  stdin?: () => Promise<string>;
}
interface Replacement { start: number; end: number; uri: string; comment?: string }
interface Input { name: string; source: string; json: boolean; documents: number; ended: boolean; firstVersionExplicit: boolean; firstStart: boolean; lastVersion?: string; replacements: Replacement[] }

function reference(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("bunko://")) return;
  // Template expressions are intentionally left for the caller's renderer.
  if (/\$\{[^}]+\}|\{\{[\s\S]*?\}\}/.test(value)) return;
  if (value === "bunko://" || /[\s{}$\\?#\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid bunko reference: ${value}`);
  return value;
}

/** Keep the original text; the YAML AST identifies exact scalar ranges. This
 * also preserves comments, formatting, numeric precision and anchor syntax. */
export function parseInput(name: string, source: string): Input {
  let json = false;
  try { JSON.parse(source); json = true; }
  catch { if (extname(name).toLowerCase() === ".json") throw new Error(`Invalid JSON: ${name}`); }
  const documents = parseAllDocuments(source, { keepSourceTokens: true, prettyErrors: true, logLevel: "silent" });
  const replacements: Replacement[] = [];
  for (const document of documents) {
    if (document.errors.length) throw new Error(`${name}: ${document.errors[0]!.message}`);
    if (document.warnings.length) throw new Error(`${name}: ${document.warnings[0]!.message}`);
    const scalarValues = new Map<Node, string>(), aliases: { node: Node; target: Node; key: boolean }[] = [];
    function walk(node: unknown, key = false) {
      if (isScalar(node)) { if (!key) { const uri = reference(node.value); if (uri) scalarValues.set(node, uri); } }
      else if (isAlias(node)) {
        const target = node.resolve(document);
        if (!target) throw new Error(`${name}: unresolved YAML alias ${node.source}`);
        aliases.push({ node, target, key });
      } else if (isMap(node)) for (const pair of node.items) { walk(pair.key, true); walk(pair.value, key); }
      else if (isSeq(node)) for (const item of node.items) walk(item, key);
    }
    walk(document.contents);
    const add = (node: Node, uri: string) => {
      if (!node.range) throw new Error("Missing YAML source range");
      const token = node.srcToken;
      const comment = token?.type === "block-scalar" ? token.props.flatMap((p) => p.type === "comment" ? [p.source] : []).join(" ") : undefined;
      replacements.push({ start: node.range[0], end: node.range[1], uri, comment });
    };
    for (const [node, uri] of scalarValues) add(node, uri);
    function containsReplacement(node: unknown, seen = new Set<unknown>()): boolean {
      if (seen.has(node)) return false;
      seen.add(node);
      if (isAlias(node)) return containsReplacement(node.resolve(document), seen);
      if (isScalar(node)) return scalarValues.has(node);
      if (isMap(node)) return node.items.some((p) => containsReplacement(p.key, seen) || containsReplacement(p.value, seen));
      if (isSeq(node)) return node.items.some((item) => containsReplacement(item, seen));
      return false;
    }
    function containsUnselectedReference(node: unknown, seen = new Set<unknown>()): boolean {
      if (seen.has(node)) return false;
      seen.add(node);
      if (isAlias(node)) return containsUnselectedReference(node.resolve(document), seen);
      if (isScalar(node)) return !scalarValues.has(node) && Boolean(reference(node.value));
      if (isMap(node)) return node.items.some((pair) => containsUnselectedReference(pair.value, seen));
      if (isSeq(node)) return node.items.some((item) => containsUnselectedReference(item, seen));
      return false;
    }
    for (const alias of aliases) {
      if (!alias.key && !isScalar(alias.target) && containsUnselectedReference(alias.target)) throw new Error(`${name}: image collections anchored in mapping keys are not supported`);
      if (alias.key && containsReplacement(alias.target)) throw new Error(`${name}: an image anchor cannot also be used as a mapping key`);
      if (!alias.key && isScalar(alias.target) && !scalarValues.has(alias.target)) {
        const uri = reference(alias.target.value); if (uri) add(alias.node, uri);
      }
    }
  }
  return { name, source, json, documents: documents.length, ended: Boolean(documents.at(-1)?.directives.docEnd), firstVersionExplicit: Boolean(documents[0]?.directives.yaml.explicit), firstStart: Boolean(documents[0]?.directives.docStart), lastVersion: documents.at(-1)?.directives.yaml.version, replacements };
}

async function readInputs(options: ResolveOptions): Promise<Input[]> {
  if (!options.files.length) throw new Error("resolve requires -f <file|directory|->");
  const match = options.selector === undefined ? undefined : labelSelector(options.selector);
  let found = false;
  const add = (name: string, source: string) => {
    found = true;
    const selected = match ? selectDocuments(name, source, match) : source;
    if (selected !== undefined) inputs.push(parseInput(name, selected));
  };
  const inputs: Input[] = [], seen = new Set<string>();
  async function read(path: string) {
    const canonical = path === "-" ? path : await realpath(absolute(path));
    if (seen.has(canonical)) return;
    seen.add(canonical);
    if (canonical === "-") { add("stdin", await (options.stdin ?? (() => Bun.stdin.text()))()); return; }
    if ((await stat(canonical)).isDirectory()) {
      for (const entry of (await readdir(canonical, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (entry.isFile() && /\.(?:yaml|yml|json)$/i.test(entry.name) || entry.isDirectory() && options.recursive) await read(join(canonical, entry.name));
      }
    } else add(canonical, await readFile(canonical, "utf8"));
  }
  for (const path of options.files) await read(path);
  if (!found) throw new Error("No YAML/JSON inputs found");
  return inputs;
}

export function renderInputs(inputs: Input[], references: Map<string, string>): string {
  if (!inputs.length) return "";
  const rendered = inputs.map((input) => {
    let source = input.source;
    for (const replacement of [...input.replacements].sort((a, b) => b.start - a.start)) {
      const value = references.get(replacement.uri);
      if (!value) throw new Error(`Missing image result: ${replacement.uri}`);
      const original = source.slice(replacement.start, replacement.end);
      // A block scalar's range includes the final newline before the next key.
      source = source.slice(0, replacement.start) + JSON.stringify(value) + (replacement.comment ? " " + replacement.comment : "") + (original.endsWith("\r\n") ? "\r\n" : original.endsWith("\n") ? "\n" : "") + source.slice(replacement.end);
    }
    return source;
  });
  if (inputs.every((input) => input.json)) {
    for (const source of rendered) JSON.parse(source);
    return (rendered.length === 1 ? rendered[0]!.trim() : `[\n${rendered.map((s) => s.trim()).join(",\n")}\n]`) + "\n";
  }
  // Explicit document ends allow subsequent implicit starts and directives.
  let output = "", openDocument = false, lastVersion: string | undefined;
  for (const [index, source] of rendered.entries()) {
    const input = inputs[index]!;
    if (input.documents) {
      if (openDocument) output += "...\n";
      // YAML 1.1 directives carry into later documents. A separate input file
      // starts with the default 1.2 schema unless it declares its own version.
      if (lastVersion === "1.1" && !input.firstVersionExplicit) output += "%YAML 1.2\n" + (input.firstStart ? "" : "---\n");
      openDocument = !input.ended;
      lastVersion = input.lastVersion;
    }
    output += source.endsWith("\n") ? source : source + "\n";
  }
  parseInput("resolved.yaml", output);
  return output;
}

export async function resolveDocuments(options: ResolveOptions): Promise<{ output: string; targets: BuildResult[] }> {
  if (options.jobs !== undefined && (!Number.isSafeInteger(options.jobs) || options.jobs < 1 || options.jobs > 32)) throw new Error("--jobs must be an integer from 1 to 32");
  if (options.cosignPath && !options.signKey) throw new Error("cosignPath requires signKey");
  if (options.signKey && !Bun.which(options.cosignPath ?? "cosign")) throw new Error("Signing requires cosign on PATH or --cosign-path");
  const configuredRepo = options.repo ?? process.env.BUNKO_REPO;
  if (configuredRepo !== undefined) repository(options.bare ? configuredRepo : `${configuredRepo}/bunko-validation`);
  if (options.externalDeps) throw new Error("External dependency artifacts require build; resolve needs per-target mappings");
  if (options.push === false || options.local || options.kind || options.output || options.tarball || options.dryRun || options.targets) throw new Error("resolve requires Registry publication; export/local/kind/dry-run/--target are not supported");
  const report = options.report ? await canonicalOutput(options.report) : undefined;
  if (report) await assertFileAvailable(report, "Report");
  const imageRefs = await referenceOutput(options.imageRefs, [options.report, options.cacheDir, options.installCache]);
  const inputs = await readInputs(options);
  const context = await realpath(absolute(options.context ?? "."));
  const uriTargets = new Map<string, string>(), names = new Map<string, string>();
  const groups = new Map<string, { directory: string; paths: Set<string>; workspace: boolean }>();
  for (const uri of new Set(inputs.flatMap((input) => input.replacements.map((r) => r.uri)))) {
    const found = await discover({ path: absolute(context, uri.slice("bunko://".length)) });
    if (found.targets.length !== 1) throw new Error(`Reference ${uri} selects multiple targets; use a service directory`);
    const path = join(found.directory, found.targets[0]!.path);
    uriTargets.set(uri, path);
    const project = await loadProject({ ...options, path }, found.workspace);
    const collision = names.get(project.name);
    if (collision && collision !== path) throw new Error(`Resolve image name collision: ${project.name}; set distinct bunko.imageName values`);
    names.set(project.name, path);
    if (!groups.has(found.directory)) groups.set(found.directory, { directory: found.directory, paths: new Set(), workspace: Boolean(found.workspace) });
    groups.get(found.directory)!.paths.add(found.targets[0]!.path || ".");
  }
  if (options.bare && names.size > 1) throw new Error("--bare requires a single resolved target");
  const batches: PreparedTargets[] = [], references = new Map<string, string>();
  const paths = [...new Set(uriTargets.values())].sort(), completed = new Set<string>();
  const sources: Parameters<typeof prepareTargets>[2] = new Map();
  try {
    for (const group of [...groups.values()].sort((a, b) => a.directory < b.directory ? -1 : 1)) {
      const batch = await prepareTargets({ ...options, path: group.directory, targets: group.workspace ? [...group.paths] : undefined, report: undefined, imageRefs: undefined, push: true }, false, sources);
      batches.push(batch);
      for (const target of batch.results) if (names.get(target.target) !== join(group.directory, target.targetPath ?? ".")) throw new Error("Target identity changed during resolve; retry the invocation");
    }
    const targets = batches.flatMap((batch) => batch.results);
    for (const target of targets) {
      const path = names.get(target.target)!;
      const repo = options.repo ?? process.env.BUNKO_REPO!;
      const ref = `${repositoryName(repository(options.bare ? repo : `${repo}/${target.target}`))}@${target.root.digest}`;
      for (const [uri, selected] of uriTargets) if (selected === path) references.set(uri, ref);
    }
    // Validate complete rendered output before any publication. Only the caller
    // writes stdout, after every finish and the optional report have succeeded.
    const output = renderInputs(inputs, references);
    for (const batch of batches) {
      await batch.finish();
      for (const target of batch.results) completed.add(names.get(target.target)!);
    }
    if (imageRefs) await writeReferences(imageRefs, targets.map((target) => target.publication!.reference));
    if (report) await writeReport(report, { schemaVersion: 4, command: "resolve", status: "success", references: Object.fromEntries(references), targets });
    return { output, targets };
  } catch (error) {
    for (const batch of batches) for (const target of batch.results) if (target.publication?.published && !target.publication.pendingTags.length && (!target.supplyChain || target.supplyChain.status === "complete")) completed.add(names.get(target.target)!);
    if (report) await writeReport(report, { schemaVersion: 4, command: "resolve", status: "failed", error: error instanceof Error ? error.message : "Resolve failed", targets: batches.flatMap((batch) => batch.results), pendingTargets: paths.filter((path) => !completed.has(path)) });
    throw error;
  } finally { await Promise.all(batches.map((batch) => batch.dispose())); }
}
