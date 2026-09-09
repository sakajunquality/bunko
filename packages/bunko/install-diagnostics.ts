const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** Ordered scrubbers: URL components first so later placeholders cannot break URL matching, then credential keys, headers and token shapes. */
const scrubbers: [RegExp, string][] = [
  // URL query strings and userinfo (`https://user:pass@host`), for absolute and scheme-relative URLs.
  [/((?:[a-z][a-z0-9+.-]*:)?\/\/[^\s"'<>?#]+)\?[^\s"'<>#]*/gi, "$1?<redacted>"],
  [/((?:[a-z][a-z0-9+.-]*:)?\/\/)[^\s/@"'<>]+@/gi, "$1<redacted>@"],
  // npmrc keys such as `//host/:_authToken=...`, `_auth=...`, `_password=...`, `always-auth=...`, with `=` or `:` separators.
  [/(\b(?:_authToken|_auth|_password|always-auth)["']?\s*[=:]\s*)["']?[^\s"',;]+["']?/gi, "$1<redacted>"],
  // `Authorization: Bearer ...` / `Authorization: Basic ...` header values, and bare bearer tokens.
  [/(authorization["']?\s*[=:]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi, "$1<redacted>"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <redacted>"],
  // npm and GitHub token shapes.
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "<redacted>"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "<redacted>"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, "<redacted>"],
];

/**
 * Scrubs credentials, private URL components and build-staging paths from Bun
 * installer output so a failure can be described without leaking registry
 * secrets. `roots` are absolute host paths (the temporary install root) that are
 * replaced by a stable placeholder.
 */
export function redactInstallerOutput(text: string, roots: string[] = [], secrets: string[] = []): string {
  let output = text.replace(ANSI, "").replace(/\r\n?/g, "\n");
  if (secrets.some((secret) => secret && secret.length < 6 && output.includes(secret))) return "Installer diagnostics omitted because a credential is too short to redact reliably.";
  for (const secret of [...new Set(secrets.flatMap((value) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]))].filter(Boolean).sort((a, b) => b.length - a.length)) output = output.split(secret).join("<redacted>");
  for (const [pattern, replacement] of scrubbers) output = output.replace(pattern, replacement);
  for (const root of roots) if (root) output = output.split(root).join("<build-root>");
  return output;
}

/** The last `limit` nonblank redacted lines of stderr (or stdout when stderr is empty), formatted as an error-message suffix; empty when the installer printed nothing. */
export function installerOutputTail(stderr: string, stdout: string, root: string, limit = 20, secrets: string[] = []): string {
  const lines = redactInstallerOutput(stderr.trim() ? stderr : stdout, [root], secrets).split("\n").map((line) => line.trimEnd()).filter(Boolean).map((line) => line.length > 512 ? `${line.slice(0, 512)}…` : line);
  if (!lines.length) return "";
  const tail = lines.slice(-limit);
  return `\nInstaller output (redacted${tail.length < lines.length ? `, last ${tail.length} of ${lines.length} lines` : ""}):\n${tail.map((line) => `  ${line}`).join("\n")}`;
}

/** Expanded npmrc credentials are scrubbed even when diagnostics omit their keys. */
export function installerCredentials(npmrc: string | undefined): string[] {
  const secrets: string[] = [];
  for (const line of npmrc?.split(/\r?\n/) ?? []) {
    const match = /(?:^|:)(_authToken|_auth|_password|username)\s*=\s*(.*)$/.exec(line);
    if (!match?.[2]) continue;
    const raw = match[2].trim();
    const value = /^(?:".*"|'.*')$/.test(raw) ? raw.slice(1, -1) : raw;
    secrets.push(raw, value);
    if ((match[1] === "_auth" || match[1] === "_password") && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0) {
      const decoded = Buffer.from(value, "base64");
      if (decoded.toString("base64") === value) secrets.push(decoded.toString("utf8"));
    }
  }
  return secrets.filter(Boolean);
}
