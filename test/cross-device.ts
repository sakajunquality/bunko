import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

/** Run cross-device tests only where a writable, distinct Linux shared-memory mount is available. */
export async function crossDeviceAvailable(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  let probe: string | undefined;
  try {
    probe = await mkdtemp("/dev/shm/bunko-device-probe-");
    return (await stat(probe)).dev !== (await stat(tmpdir())).dev;
  } catch { return false; }
  finally { if (probe) await rm(probe, { recursive: true, force: true }); }
}
