/** Preserve common unambiguous SPDX identifiers. Unknown or compound license
 * declarations remain unknown rather than being guessed or rewritten. */
const licenses = new Set(["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "MPL-2.0", "Unlicense", "CC0-1.0", "Zlib", "BSL-1.0", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later"]);
export function packageLicense(value: unknown): string | undefined {
  return typeof value === "string" && licenses.has(value) ? value : undefined;
}
