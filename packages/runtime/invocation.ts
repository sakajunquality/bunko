import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp as nativeMkdtemp, rm } from "node:fs/promises";

interface Invocation {
  controller: AbortController;
  children: Set<Bun.Subprocess>;
  directories: Set<string>;
}
const current = new AsyncLocalStorage<Invocation>();

/** Library calls outside a CLI invocation retain their existing behavior. */
export function throwIfCancelled(): void { current.getStore()?.controller.signal.throwIfAborted(); }
export function invocationSignal(signal?: AbortSignal | null): AbortSignal | undefined {
  const own = current.getStore()?.controller.signal;
  return own && signal ? AbortSignal.any([own, signal]) : own ?? signal ?? undefined;
}

function trackedSpawn(allowCancelled: boolean): typeof Bun.spawn {
  return new Proxy(Bun.spawn, {
    apply(target, receiver, args) {
      if (!allowCancelled) throwIfCancelled();
      const child = Reflect.apply(target, receiver, args) as Bun.Subprocess;
      const invocation = current.getStore();
      if (invocation) {
        invocation.children.add(child);
        // Cleanup may start after the invocation's first child-kill timer fired.
        const timer = invocation.controller.signal.aborted ? setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
        }, 1000) : undefined;
        void child.exited.finally(() => { clearTimeout(timer); invocation.children.delete(child); }).catch(() => {});
      }
      return child;
    },
  });
}

/** Track only processes started by this invocation, never unrelated system processes. */
export const spawn = trackedSpawn(false);
/** Cleanup commands remain possible after cancellation, with a bounded lifetime. */
export const cleanupSpawn = trackedSpawn(true);

/** Register temporary directories at creation, including ones not yet returned by a build. */
export const mkdtemp: typeof nativeMkdtemp = new Proxy(nativeMkdtemp, {
  async apply(target, receiver, args) {
    throwIfCancelled();
    const directory = await Reflect.apply(target, receiver, args);
    current.getStore()?.directories.add(String(directory));
    return directory;
  },
});

export async function pause(milliseconds: number): Promise<void> {
  const signal = invocationSignal();
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** CLI-owned lifecycle: abort work, drain children, then remove registered scratch.
 * A hard deadline exits without deleting paths that might still have active writers. */
export async function runInvocation(task: () => Promise<number>, graceMs = 10_000): Promise<number> {
  const invocation: Invocation = { controller: new AbortController(), children: new Set(), directories: new Set() };
  let exit: number | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    if (exit !== undefined) return;
    exit = signal === "SIGINT" ? 130 : 143;
    invocation.controller.abort(new Error(`Build cancelled by ${signal}`));
    for (const child of invocation.children) { try { child.kill("SIGTERM"); } catch { /* Already exited. */ } }
    killTimer = setTimeout(() => {
      for (const child of invocation.children) { try { child.kill("SIGKILL"); } catch { /* Already exited. */ } }
    }, Math.min(1000, graceMs / 2));
    deadline = setTimeout(() => {
      process.stderr.write("bunko: cancellation deadline reached; scratch retained because work has not drained\n");
      process.exit(exit!);
    }, graceMs);
  };
  const interrupt = () => stop("SIGINT"), terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    return await current.run(invocation, async () => {
      let result: number;
      try { result = await task(); }
      catch (error) { if (exit === undefined) throw error; result = exit; }
      finally {
        if (exit !== undefined) {
          await Promise.allSettled([...invocation.children].map((child) => child.exited));
          const removed = await Promise.allSettled([...invocation.directories].map((path) => rm(path, { recursive: true, force: true })));
          if (removed.some((item) => item.status === "rejected")) process.stderr.write("bunko: some invocation scratch could not be removed\n");
        }
      }
      return exit ?? result;
    });
  } finally {
    clearTimeout(killTimer); clearTimeout(deadline);
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
  }
}
