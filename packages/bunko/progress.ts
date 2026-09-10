import { AsyncLocalStorage } from "node:async_hooks";
import { measured } from "./telemetry.ts";

export interface ProgressEvent {
  schemaVersion: 1;
  phase: "snapshot" | "prepare" | "publish" | "base-resolve" | "base-inspect" | "base-pull" | "runtime" | "assemble" | "build-deps" | "install" | "bundle" | "pack" | "push";
  status: "started" | "completed" | "failed";
  target?: string;
  platform?: string;
  durationMs?: number;
}

const active = new AsyncLocalStorage<{ emit?: (event: ProgressEvent) => void; target?: string; platform?: string; targetKey?: string }>();

/** Shared stage boundaries supply progress events and OpenTelemetry measurements. */
export async function phase<T>(emit: ((event: ProgressEvent) => void) | undefined, name: ProgressEvent["phase"], task: () => Promise<T>, target?: string, platform?: string, targetKey?: string): Promise<T> {
  const parent = active.getStore();
  targetKey ??= target === undefined || target === parent?.target ? parent?.targetKey : undefined;
  emit ??= parent?.emit; target ??= parent?.target; platform ??= parent?.platform;
  const start = performance.now();
  emit?.({ schemaVersion: 1, phase: name, status: "started", target, platform });
  try {
    const result = await measured(name, () => active.run({ emit, target, platform, targetKey }, task), targetKey ?? target, platform);
    emit?.({ schemaVersion: 1, phase: name, status: "completed", target, platform, durationMs: performance.now() - start });
    return result;
  } catch (error) {
    emit?.({ schemaVersion: 1, phase: name, status: "failed", target, platform, durationMs: performance.now() - start });
    throw error;
  }
}
