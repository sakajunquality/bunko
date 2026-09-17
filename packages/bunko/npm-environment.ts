/** Only the invoking operator can grant access to host variables. Project files cannot grant it. */
export function npmEnvironment(name: string, validate = true): string {
  const allow = (process.env.BUNKO_NPM_CREDENTIAL_ENV ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (allow.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) throw new Error("Invalid BUNKO_NPM_CREDENTIAL_ENV allowlist");
  if (!/^BUNKO_NPM_[A-Za-z0-9_]+$/.test(name) && !allow.includes(name) || name === "BUNKO_NPM_CREDENTIAL_ENV") throw new Error("npm environment expansion requires BUNKO_NPM_* or an operator BUNKO_NPM_CREDENTIAL_ENV allowlist");
  if (!validate) return "bunko-credential-placeholder";
  const value = process.env[name];
  if (value === undefined || /[\r\n\0]/.test(value)) throw new Error("Missing or invalid allowed npm environment variable");
  return value;
}
