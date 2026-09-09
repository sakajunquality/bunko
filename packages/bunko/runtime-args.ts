/** Runtime argv must leave the configured application as Bun's entrypoint. */
const booleans = new Set([
  "--watch", "--hot", "--no-clear-screen", "--smol", "--cpu-prof", "--cpu-prof-md", "--heap-prof", "--heap-prof-md",
  "--no-install", "--prefer-offline", "--prefer-latest", "--expose-gc", "--no-deprecation", "--throw-deprecation",
  "--zero-fill-buffers", "--use-system-ca", "--use-openssl-ca", "--use-bundled-ca", "--redis-preconnect", "--sql-preconnect",
  "--no-addons", "--no-env-file", "--no-orphans", "--experimental-http2-fetch", "--experimental-http3-fetch",
  "--insecure-http-parser", "--experimental-stream-iter", "--no-warnings", "--trace-warnings", "--trace-deprecation",
  "--pending-deprecation", "--tls-min-v1.0", "--tls-min-v1.1", "--tls-min-v1.2", "--tls-min-v1.3", "--tls-max-v1.2", "--tls-max-v1.3",
  "--no-ffi-cc", "--preserve-symlinks", "--preserve-symlinks-main", "--no-macros", "--jsx-side-effects", "--ignore-dce-annotations",
]);
const valued = new Set([
  "--preload", "--require", "--import", "--cpu-prof-name", "--cpu-prof-dir", "--cpu-prof-interval", "--heap-prof-name", "--heap-prof-dir",
  "--heap-prof-interval", "--port", "--conditions", "--fetch-preconnect", "--max-http-header-size", "--dns-result-order", "--title",
  "--unhandled-rejections", "--console-depth", "--user-agent", "--env-file", "--cwd", "--config", "--watch-kill-signal", "--redirect-warnings",
  "--disable-warning", "--main-fields", "--extension-order", "--tsconfig-override", "--define", "--drop", "--feature", "--loader",
  "--jsx-factory", "--jsx-fragment", "--jsx-import-source", "--jsx-runtime",
]);
const optional = new Set(["--inspect", "--inspect-wait", "--inspect-brk"]);
const aliases: Record<string, string> = { "-r": "--preload", "-c": "--config", "-d": "--define", "-l": "--loader" };

export function validateRuntimeArgs(args: string[]): void {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const equal = argument.indexOf("="), raw = equal < 0 ? argument : argument.slice(0, equal);
    const flag = aliases[raw] ?? raw;
    if (booleans.has(flag) && equal < 0) continue;
    if (optional.has(flag) && equal < 0) continue;
    if (valued.has(flag) || optional.has(flag)) {
      const value = equal < 0 ? args[++index] : argument.slice(equal + 1);
      if (value && (equal >= 0 || !value.startsWith("-")) && !value.includes("\0")) continue;
      throw new Error(`runtime.args requires a non-empty value for ${flag}; use --option=value`);
    }
    // Never echo an unrecognized argument: it may contain a secret or script body.
    throw new Error(`Invalid runtime.args at index ${index}: expected a supported Bun runtime option; put application arguments in args`);
  }
}
