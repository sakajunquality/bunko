import { isBuiltin } from "node:module";
import { posix } from "node:path";
import { object } from "../oci/digest.ts";
import type { Project } from "./config.ts";

export type UndeclaredImportPolicy = "warn" | "error" | "off" | "strict";
export interface UndeclaredImport { code: "BUNKO_UNDECLARED_IMPORT" | "BUNKO_OPTIONAL_IMPORT"; package: string; version: string; path: string; name: string; file: string }
/** Ascending strictness: a shared closure is governed by the highest rank among its targets. */
const policyRank: Record<UndeclaredImportPolicy, number> = { off: 0, warn: 1, error: 2, strict: 3 };
/** Files above this size are skipped: they are almost always bundles, and a native scan of them is not free. */
export const undeclaredImportSizeLimit = 4 * 1024 * 1024;
export const undeclaredImportLimit = 100;
const scannable = /\.[cm]?js$/;
const transpiler = new Bun.Transpiler({ loader: "js" });
/** Directories and file names that hold tests and benchmarks packages ship by accident; consulted only when a package has no resolvable entry point. */
const testDirectories = new Set(["test", "tests", "__tests__", "spec", "bench", "benchmark", "browser-test", "system-test"]);
const testFile = /(?:^|\.)(?:test|spec|bench)\.[cm]?js$/;

/** The strictest selected policy governs a shared closure, so one target cannot silence another's findings. */
export function undeclaredImportPolicy(projects: Pick<Project, "undeclaredImports">[]): UndeclaredImportPolicy {
  return projects.reduce<UndeclaredImportPolicy>((strictest, p) => policyRank[p.undeclaredImports] > policyRank[strictest] ? p.undeclaredImports : strictest, "off");
}

export function undeclaredImportMessage(item: UndeclaredImport): string {
  return `${item.code} ${item.package}@${item.version} imports ${JSON.stringify(item.name)} without declaring it (${item.file}); strict declaration policy requires fixing the importing package manifest. As a runtime workaround, declare it in the application's dependencies and bunko.external and use deps.undeclaredImports=warn; verify runtime resolution in the image.`;
}

/** Reported only under the `strict` policy: every textual use of the name the pass found is guarded by the package itself. That is evidence, not
 * a proof of safety — see guardedImports for what the classification does not model — so strict builds can still demand the declaration. */
export function optionalImportMessage(item: UndeclaredImport): string {
  return `${item.code} ${item.package}@${item.version} imports ${JSON.stringify(item.name)} only inside try/catch (${item.file}); treated as optional`;
}

/** Package name of a bare specifier, or undefined for relative, absolute, protocol, subpath-import and malformed specifiers. */
export function bareSpecifierPackage(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") || specifier === "bun" || isBuiltin(specifier) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return undefined;
  const match = /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+(?=\/|$)/.exec(specifier);
  return match?.[0];
}

/** Names an instance may resolve without help: itself plus every declared dependency, optional dependency or peer (optional peers included). */
export function declaredNames(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  if (typeof manifest.name === "string") names.add(manifest.name);
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) for (const name of Object.keys(object(manifest[key] ?? {}, key))) names.add(name);
  return names;
}

export function scannableRuntimeFile(path: string, size: number): boolean {
  return scannable.test(path) && size <= undeclaredImportSizeLimit;
}

/** Files the reachability scan may consult: JavaScript modules and the package manifests that direct directory imports. */
export function candidateRuntimeFile(path: string): boolean {
  return scannable.test(path) || path === "package.json" || path.endsWith("/package.json");
}

/** Shipped test material, recognized by well-known directory names at any depth and by test, *.test, *.spec and *.bench file names. */
export function testLocation(file: string): boolean {
  const segments = file.split("/");
  return segments.slice(0, -1).some((segment) => testDirectories.has(segment)) || testFile.test(segments.at(-1)!);
}

/** Every literal specifier the transpiler finds: static import/export sources, require() literals and import() literals. A shebang line is
 * dropped first; unparseable files yield nothing. The scan is native and cheap, and it recognizes forms a textual prefilter would miss, such
 * as an escaped `\u0072equire`, so every candidate file is handed to it. */
export function importSpecifiers(code: string): string[] {
  try { return transpiler.scanImports(code.replace(/^#![^\n]*/, "")).map((item) => item.path); } catch { return []; }
}

/** Advisory syntax scan of one file: bare specifiers that are neither builtins nor declared, sorted. */
export function undeclaredImports(code: string, declared: Set<string>): string[] {
  const missing = new Set<string>();
  for (const path of importSpecifiers(code)) {
    const name = bareSpecifierPackage(path);
    if (name && !declared.has(name)) missing.add(name);
  }
  return [...missing].sort();
}

const identifier = /[\w$]+/y, blank = /\s+/y, flags = /[a-z]*/y;
/** Identifiers as ECMAScript spells them: the ASCII matcher above is the fast path, and this one takes over at any code point it stops on,
 * so a non-ASCII or escaped identifier is never split into tokens that could spell a keyword. */
const escapedPart = /\\u\{[0-9a-fA-F]{1,6}\}|\\u[0-9a-fA-F]{4}/u.source;
const identifierStart = /^[$_\p{ID_Start}]/u;
const unicodeIdentifier = new RegExp(`(?:[$_\\p{ID_Start}]|${escapedPart})(?:[$\\u200C\\u200D\\p{ID_Continue}]|${escapedPart})*`, "uy");
/** Numeric literals are tokenised whole, so a trailing `.` or an exponent cannot be mistaken for the token before a `/`. */
const numeric = /0[xX][0-9a-fA-F][0-9a-fA-F_]*n?|0[oO][0-7][0-7_]*n?|0[bB][01][01_]*n?|(?:\d[\d_]*)?\.\d[\d_]*(?:[eE][+-]?\d[\d_]*)?|\d[\d_]*\.?(?:[eE][+-]?\d[\d_]*)?n?/y;
/** A line comment ends at any line terminator; a string literal may not contain a raw LF or CR, but U+2028 and U+2029 are allowed in it. */
const lineEnd = /[\n\r\u2028\u2029]/g;
/** Reserved words after which a `/` opens a regular expression rather than dividing. None of them can name a value, so the reading is certain. */
const regexKeywords = new Set(["return", "typeof", "instanceof", "in", "case", "new", "delete", "void", "do", "else", "throw"]);
/** Words that read as keywords in some positions and as plain identifiers in others; a `/` after one is ambiguous. */
const contextualWords = new Set(["of", "yield", "await"]);
/** Heads whose parenthesis is a control header, so the `)` that closes it is followed by a statement and never by a division. */
const controlHeads = new Set(["if", "while", "for", "with"]);
const simpleEscapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };
/** Template substitutions nested deeper than this abandon the pass; real code never approaches it. */
const templateDepthLimit = 8;

/** Cooked value of a string or template body, or undefined when it holds an escape this pass does not decode (legacy octal, `\8`, `\9`,
 * a malformed `\x`, `\u` or `\u{}`). An undecodable literal could name any candidate, so it abandons the file rather than being skipped. */
export function cookedLiteral(raw: string): string | undefined {
  if (!raw.includes("\\")) return raw;
  let value = "", i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c !== "\\") { value += c; i++; continue; }
    const escape = raw[i + 1];
    if (escape === undefined) return undefined;
    // A line continuation contributes nothing; CRLF counts as one terminator.
    if (escape === "\n" || escape === "\u2028" || escape === "\u2029") { i += 2; continue; }
    if (escape === "\r") { i += raw[i + 2] === "\n" ? 3 : 2; continue; }
    if (escape >= "0" && escape <= "9") {
      const next = raw[i + 2];
      if (escape !== "0" || (next !== undefined && next >= "0" && next <= "9")) return undefined;
      value += "\0"; i += 2; continue;
    }
    if (escape === "x") { const hex = raw.slice(i + 2, i + 4); if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined; value += String.fromCharCode(parseInt(hex, 16)); i += 4; continue; }
    if (escape === "u") {
      if (raw[i + 2] === "{") {
        const end = raw.indexOf("}", i + 3), hex = end < 0 ? "" : raw.slice(i + 3, end);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return undefined;
        value += String.fromCodePoint(parseInt(hex, 16)); i = end + 1; continue;
      }
      const hex = raw.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
      value += String.fromCharCode(parseInt(hex, 16)); i += 6; continue;
    }
    value += simpleEscapes[escape] ?? escape; i += 2;
  }
  return value;
}

/** Occurrences of the candidate packages one file holds: `guarded` names every candidate whose every occurrence in it is guarded, `unguarded`
 * every candidate with at least one occurrence that is not, and `certain` is false when the pass abandoned the file. */
export interface GuardScan { guarded: Set<string>; unguarded: Set<string>; certain: boolean }

/** How one file uses each of `candidates`, so a caller can tell a probe the package guards itself from an import it needs. The candidates
 * belong to the whole package instance, not to this file: a name is only optional when no reached file uses it unguarded, and an uncertain
 * file (`certain: false`) leaves the instance unable to call anything optional.
 * `Bun.Transpiler#scanImports` reports specifiers without positions, so this adds one lexical pass that skips comments, strings, template
 * literals and regular expressions and tracks the enclosing `try` blocks with a brace stack. Every literal whose cooked value names a
 * candidate is an occurrence: it is guarded only as `require.resolve(...)` probing, or as `require(...)`/`import(...)` inside a `try` block
 * that a `catch` protects, at any depth. Every other position — a static `import`/`export … from` source, a member call such as
 * `object.require(...)`, a `try` block with only a `finally`, or a plain string mention such as the `"x"` a computed `require(name)` later
 * resolves — puts the name in `unguarded`, as does a candidate the pass never locates. The pass abandons the file, guarding nothing, whenever it cannot be certain: an undecodable escape, an unterminated string,
 * template, comment or regular expression, unbalanced braces or parentheses, a `/` whose operator or regular-expression reading is
 * ambiguous, an untokenisable character, or template substitutions nested past `templateDepthLimit`. Uncertainty only ever applies to a file
 * that mentions a candidate: one holding neither a candidate name nor a backslash is proven free of occurrences and is not lexed at all. Execution order is not modelled: a `require()` a `try` block only
 * defers (an arrow, function or class method it declares) still counts as guarded. */
export function scanGuards(code: string, candidates: Set<string>): GuardScan {
  const guarded = new Set<string>(), unguarded = new Set<string>(), pending: { name: string; tries: number[] }[] = [];
  const abandoned = (): GuardScan => ({ guarded: new Set(), unguarded: new Set(), certain: false });
  // A file holding no backslash and no candidate name cannot hold an occurrence: without escapes a literal's cooked value is its raw text,
  // so a value naming a candidate would contain that name verbatim, and a template with substitutions is never classified. Such a file is
  // therefore known to be empty of occurrences rather than merely unlexed, and its syntax is never inspected.
  if (!candidates.size) return { guarded, unguarded, certain: true };
  // A file too large to lex could hold an unguarded occurrence of anything.
  if (code.length > undeclaredImportSizeLimit) return abandoned();
  if (!code.includes("\\") && ![...candidates].some((name) => code.includes(name))) return { guarded, unguarded, certain: true };
  const braces: ("try" | "block" | "template")[] = [], parens: boolean[] = [], openTries: number[] = [], protective = new Set<number>();
  // `closedTry` holds the try block that just closed until the next token says whether a `catch` protects it; `header` records whether the
  // parenthesis that closed last was a control header, which decides the reading of a `/` after it.
  let i = 0, tries = 0, templates = 0, template = false, closedTry = -1, header: boolean | undefined, newline = false;
  let t1 = "", t2 = "", t3 = "", t4 = "", t5 = "";
  const mark = (token: string) => {
    if (closedTry >= 0) { if (token === "catch") protective.add(closedTry); closedTry = -1; }
    t5 = t4; t4 = t3; t3 = t2; t2 = t1; t1 = token; newline = false;
  };
  /** False when the literal cannot be decoded: its value could name any candidate, so the caller abandons the file. */
  const classify = (raw: string): boolean => {
    const value = cookedLiteral(raw);
    if (value === undefined) return false;
    const name = bareSpecifierPackage(value);
    if (!name || !candidates.has(name)) return true;
    if (t1 === "(" && t2 === "resolve" && t3 === "." && t4 === "require" && t5 !== ".") guarded.add(name);
    else if (t1 === "(" && (t2 === "require" || t2 === "import") && t3 !== "." && openTries.length) pending.push({ name, tries: [...openTries] });
    else unguarded.add(name);
    return true;
  };
  /** Whether a `/` at `i` opens a regular expression, divides, or cannot be told apart. A line terminator before a `/` that follows a value
   * can be an inserted semicolon, which flips the reading, and a word after `.` is a property name rather than the keyword it spells. */
  const value = () => newline ? "unsure" as const : "divide" as const;
  const slash = (): "regex" | "divide" | "unsure" => {
    if (!t1) return "regex";
    if (t1 === "}" || t1 === ".") return "unsure";
    if (t1 === ")") return header === undefined ? "unsure" : header ? "regex" : value();
    if (t1 === "]" || t1 === '"') return value();
    if (identifierStart.test(t1)) return t2 === "." ? value() : contextualWords.has(t1) ? "unsure" : regexKeywords.has(t1) ? "regex" : value();
    // A postfix ++ or -- ends a value, and its two characters are separate tokens here.
    if ((t1 === "+" || t1 === "-") && t2 === t1) return "unsure";
    return "regex";
  };
  while (i < code.length) {
    const c = code[i]!;
    if (template) {
      if (c === "\\") { i += code[i + 1] === "\r" && code[i + 2] === "\n" ? 3 : 2; continue; }
      if (c === "`") { template = false; i++; mark('"'); continue; }
      if (c === "$" && code[i + 1] === "{") { if (++templates > templateDepthLimit) return abandoned(); braces.push("template"); template = false; i += 2; mark("{"); continue; }
      i++; continue;
    }
    if (c === "/" && code[i + 1] === "/") { lineEnd.lastIndex = i + 2; const end = lineEnd.exec(code); if (!end) break; i = end.index; newline = true; continue; }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end < 0) return abandoned();
      if (lineEnd.test(code.slice(i + 2, end))) newline = true;
      lineEnd.lastIndex = 0; i = end + 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== "\n" && code[j] !== "\r") j += code[j] === "\\" ? (code[j + 1] === "\r" && code[j + 2] === "\n" ? 3 : 2) : 1;
      if (j >= code.length || code[j] !== c) return abandoned();
      if (!classify(code.slice(i + 1, j))) return abandoned();
      i = j + 1; mark('"'); continue;
    }
    if (c === "`") {
      // A template without substitutions is a literal argument like any string; one with them is lexed as code between the chunks.
      let j = i + 1, plain = false;
      while (j < code.length) {
        if (code[j] === "\\") { j += code[j + 1] === "\r" && code[j + 2] === "\n" ? 3 : 2; continue; }
        if (code[j] === "`") { plain = true; break; }
        if (code[j] === "$" && code[j + 1] === "{") break;
        j++;
      }
      if (j >= code.length) return abandoned();
      if (!plain) { template = true; i++; continue; }
      if (!classify(code.slice(i + 1, j))) return abandoned();
      i = j + 1; mark('"'); continue;
    }
    if (c === "{") { const kind = t1 === "try" ? "try" : "block"; braces.push(kind); if (kind === "try") { tries++; openTries.push(tries); } i++; mark("{"); continue; }
    if (c === "}") {
      const kind = braces.pop();
      if (!kind) return abandoned();
      if (kind === "template") { templates--; template = true; i++; mark('"'); continue; }
      const closed = kind === "try" ? openTries.pop() : undefined;
      i++; mark("}");
      if (closed !== undefined) closedTry = closed;
      continue;
    }
    if (c === "(") { parens.push(controlHeads.has(t1) && t2 !== "."); i++; mark("("); continue; }
    if (c === ")") { if (!parens.length) return abandoned(); const control = parens.pop()!; i++; mark(")"); header = control; continue; }
    if (c === "/") {
      const kind = slash();
      if (kind === "unsure") return abandoned();
      if (kind === "regex") {
        let j = i + 1, group = false, closed = false;
        while (j < code.length && code[j] !== "\n" && code[j] !== "\r") {
          const d = code[j]!;
          if (d === "\\") { j += 2; continue; }
          if (d === "[") group = true; else if (d === "]") group = false; else if (d === "/" && !group) { closed = true; break; }
          j++;
        }
        if (!closed) return abandoned();
        flags.lastIndex = j + 1; flags.exec(code); i = flags.lastIndex; mark('"'); continue;
      }
    }
    if (code.charCodeAt(i) <= 32) { if (c === "\n" || c === "\r") newline = true; i++; continue; }
    if (c >= "0" && c <= "9" || c === "." && code[i + 1]! >= "0" && code[i + 1]! <= "9") {
      numeric.lastIndex = i;
      const digits = numeric.exec(code);
      if (!digits) return abandoned();
      i = numeric.lastIndex; mark('"'); continue;
    }
    identifier.lastIndex = i;
    const word = identifier.exec(code);
    // The ASCII matcher stops at a non-ASCII code point or an identifier escape; the full matcher then takes the identifier whole.
    const next = word ? code.charCodeAt(identifier.lastIndex) : 0;
    if (word && next < 128 && next !== 92) { i = identifier.lastIndex; mark(word[0]!); continue; }
    if (word || c === "\\" || code.charCodeAt(i) >= 128) {
      unicodeIdentifier.lastIndex = i;
      const full = unicodeIdentifier.exec(code);
      // An escaped identifier never spells a call form this pass recognizes, so it marks a value and leaves its literals unguarded.
      if (full) { i = unicodeIdentifier.lastIndex; mark(full[0]!.includes("\\") ? '"' : full[0]!); continue; }
    }
    blank.lastIndex = i;
    if (blank.exec(code)) { if (lineEnd.test(code.slice(i, blank.lastIndex))) newline = true; lineEnd.lastIndex = 0; i = blank.lastIndex; continue; }
    // Outside literals, comments and regular expressions, valid source holds only ASCII punctuation here.
    if (c === "\\" || code.charCodeAt(i) >= 128) return abandoned();
    i++; mark(c);
  }
  if (braces.length || parens.length || template) return abandoned();
  // A try block only guards what its catch handler swallows; `try { … } finally { … }` rethrows.
  for (const item of pending) (item.tries.some((id) => protective.has(id)) ? guarded : unguarded).add(item.name);
  for (const name of unguarded) guarded.delete(name);
  return { guarded, unguarded, certain: true };
}

/** The candidates one file guards, for callers that do not need the rest of the scan. */
export function guardedImports(code: string, candidates: Set<string>): Set<string> {
  return scanGuards(code, candidates).guarded;
}

/** Package-relative entry points in manifest order: main, module, every string leaf of exports (all conditions, nested objects and arrays,
 * null leaves skipped), bin values and a string browser field. A leaf with `*` is expanded against the instance's files the way Node
 * substitutes it: each `*` is replaced by the same characters, including `/`. Nothing here is resolved yet. */
export function manifestEntryPoints(manifest: Record<string, unknown>, files: Iterable<string>): string[] {
  const entries: string[] = [], paths = [...files];
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value) return;
    const star = value.indexOf("*");
    if (star < 0) { entries.push(value); return; }
    const pattern = inside(value); if (pattern === undefined) return;
    const parts = pattern.split("*"), count = parts.length - 1;
    const literalLength = parts.reduce((size, part) => size + part.length, 0);
    for (const file of paths) {
      const length = (file.length - literalLength) / count;
      if (!Number.isInteger(length) || length < 0 || !file.startsWith(parts[0]!)) continue;
      const replacement = file.slice(parts[0]!.length, parts[0]!.length + length);
      if (parts.join(replacement) === file) entries.push(file);
    }
  };
  const leaves = (value: unknown) => { if (Array.isArray(value)) value.forEach(leaves); else if (value && typeof value === "object") Object.values(value).forEach(leaves); else add(value); };
  add(manifest.main); add(manifest.module); leaves(manifest.exports);
  if (typeof manifest.bin === "string") add(manifest.bin); else if (manifest.bin && typeof manifest.bin === "object") Object.values(manifest.bin).forEach(add);
  add(manifest.browser);
  return entries;
}

/** Normalize a package-relative path; undefined when it is absolute, leaves the package or enters a nested node_modules. */
function inside(path: string): string | undefined {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return undefined;
  const normalized = posix.normalize(path);
  if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("node_modules")) return undefined;
  return normalized === "." || normalized === "./" ? "" : normalized;
}

export interface ReachableFinding { name: string; file: string; optional?: true }
/** How much reached-file text the two passes may retain at once, charged as UTF-16 storage plus a per-entry allowance. It bounds what is
 * held, not what is read: a file the budget turns away is simply read a second time. */
const reachableTextBudget = 8 * 1024 * 1024;
const retainedCost = (text: string) => text.length * 2 + 64;

/** Scan the files of one package instance that its entry points reach through relative imports.
 * `files` maps package-relative paths of regular files (see candidateRuntimeFile) to sizes; `read` returns one of them as text.
 * Bare specifiers are checked against the declared names; relative ones are resolved with Node-style probing (exact file, `.js`/`.cjs`/`.mjs`,
 * a directory's package.json `main`, then its index) inside the instance, each file visited once in breadth-first order from the entry points.
 * A package with no resolvable entry point falls back to every JavaScript file outside well-known test locations, in sorted order. */
export async function reachableUndeclaredImports(manifest: Record<string, unknown>, files: Map<string, number>, read: (file: string) => Promise<string>): Promise<ReachableFinding[]> {
  const declared = declaredNames(manifest);
  const probe = (target: string) => { for (const candidate of [target, `${target}.js`, `${target}.cjs`, `${target}.mjs`]) if (scannable.test(candidate) && files.has(candidate)) return candidate; return undefined; };
  const index = (directory: string) => probe(posix.join(directory, "index"));
  async function resolve(target: string): Promise<string | undefined> {
    const file = probe(target); if (file) return file;
    const nested = posix.join(target, "package.json");
    if (files.has(nested) && files.get(nested)! <= undeclaredImportSizeLimit && nested !== "package.json") {
      let main: unknown;
      try { main = JSON.parse(await read(nested)).main; } catch { main = undefined; }
      if (typeof main === "string") { const path = inside(posix.join(target, main)); const found = path === undefined ? undefined : probe(path) ?? index(path); if (found) return found; }
    }
    return index(target);
  }
  const visited = new Set<string>(), queue: string[] = [];
  const enqueue = (file: string) => { if (!visited.has(file)) { visited.add(file); queue.push(file); } };
  for (const entry of manifestEntryPoints(manifest, files.keys())) { const path = inside(entry); const file = path === undefined ? undefined : await resolve(path); if (file) enqueue(file); }
  if (!visited.size) { const file = index(""); if (file) enqueue(file); }
  if (!visited.size) for (const file of [...files.keys()].sort()) if (scannable.test(file) && !testLocation(file)) enqueue(file);
  // First pass: reach the files and collect the instance's missing names, remembering the first file whose specifiers named each one.
  const scanned: string[] = [], candidates = new Map<string, string>(), texts = new Map<string, string>();
  let retained = 0, certain = true;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const file = queue[cursor]!;
    // A reached file too large to lex is never read, and one that will not read is not an error here: the scan is advisory, so both only
    // leave the instance unable to call anything optional. Neither contributes its own imports, so what it reaches stays undiscovered.
    if (!scannableRuntimeFile(file, files.get(file)!)) { certain = false; continue; }
    let text;
    try { text = await read(file); } catch { certain = false; continue; }
    const missing = new Set<string>();
    if (retained + retainedCost(text) <= reachableTextBudget) { texts.set(file, text); retained += retainedCost(text); }
    scanned.push(file);
    for (const specifier of importSpecifiers(text)) {
      if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
        const path = inside(posix.join(posix.dirname(file), specifier)), target = path === undefined ? undefined : await resolve(path);
        if (target) enqueue(target);
        continue;
      }
      const name = bareSpecifierPackage(specifier);
      if (name && !declared.has(name)) missing.add(name);
    }
    for (const name of [...missing].sort()) if (!candidates.has(name)) candidates.set(name, file);
  }
  if (!candidates.size) return [];
  // Second pass: classify occurrences of every candidate in every reached file, so a name is optional only when the whole instance guards
  // it. Only instances that already have a finding pay for this, and files read in the first pass are usually still in hand.
  const names = new Set(candidates.keys()), unguarded = new Map<string, string>(), guarded = new Map<string, string>();
  for (const file of scanned) {
    let text = texts.get(file);
    if (text === undefined) { try { text = await read(file); } catch { certain = false; continue; } }
    const scan = scanGuards(text, names);
    certain &&= scan.certain;
    for (const name of scan.unguarded) if (!unguarded.has(name)) unguarded.set(name, file);
    for (const name of scan.guarded) if (!guarded.has(name)) guarded.set(name, file);
  }
  // One finding per instance and missing name, in the order the first pass met them. The witness is the first file that uses the name
  // unguarded, else the first that guards it, else the first whose specifiers named it. A file the pass could not lex leaves the instance
  // uncertain, and nothing in it is optional.
  return [...candidates].map(([name, seen]) => {
    const reported = unguarded.get(name), probe = guarded.get(name);
    if (certain && reported === undefined && probe !== undefined) return { name, file: probe, optional: true as const };
    return { name, file: reported ?? probe ?? seen };
  });
}
