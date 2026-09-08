export interface ProgressEvent {
  schemaVersion: 1;
  phase: "snapshot" | "prepare" | "publish";
  status: "started" | "completed" | "failed";
  target?: string;
  durationMs?: number;
}

/** Events contain operation identity and timing, never configuration values. */
export async function phase<T>(emit: ((event: ProgressEvent) => void) | undefined, name: ProgressEvent["phase"], task: () => Promise<T>, target?: string): Promise<T> {
  const start = performance.now();
  emit?.({ schemaVersion: 1, phase: name, status: "started", target });
  try {
    const result = await task();
    emit?.({ schemaVersion: 1, phase: name, status: "completed", target, durationMs: performance.now() - start });
    return result;
  } catch (error) {
    emit?.({ schemaVersion: 1, phase: name, status: "failed", target, durationMs: performance.now() - start });
    throw error;
  }
}
