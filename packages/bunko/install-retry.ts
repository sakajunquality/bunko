/** Retry only recognized download errors, never an unrelated installer failure. */
export function transientInstallFailure(stdout: string, stderr: string): boolean {
  const lines = `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
  const errors = lines.map((line) => line.trim()).filter((line) => /^error:/i.test(line));
  if (!errors.length) return false;
  return errors.every((line) => {
    if (/\b(?:unauthorized|forbidden|integrity|checksum|lockfile|certificate)\b/i.test(line)) return false;
    if (/^error: failed to download .+: (?:ConnectionRefused|ConnectionReset|ConnectionClosed|ConnectionTimedOut|SocketClosed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\s*$/i.test(line)) return true;
    return /^error: (?:failed to download .+: (?:HTTP(?: error)? )?|GET https?:\/\/\S+ - )(?:429|5\d\d|HTTP 5xx)(?:\s|$)/i.test(line);
  });
}
