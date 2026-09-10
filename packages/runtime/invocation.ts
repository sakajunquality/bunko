import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp as nativeMkdtemp, rm } from "node:fs/promises";

interface Invocation {
  controller: AbortController;
  children: Set<Bun.Subprocess>;
  cancelledGroups: Set<number>;
  directories: Set<string>;
}
const current = new AsyncLocalStorage<Invocation>();

/** Library calls outside a CLI invocation retain their existing behavior. */
export function throwIfCancelled(): void { current.getStore()?.controller.signal.throwIfAborted(); }
export function invocationSignal(signal?: AbortSignal | null): AbortSignal | undefined {
  const own = current.getStore()?.controller.signal;
  return own && signal ? AbortSignal.any([own, signal]) : own ?? signal ?? undefined;
}

function killChild(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  // Each CLI-owned process starts a new group on Unix, so its helpers receive the
  // same signal. Outside an invocation we never alter process-group behavior.
  try { if (process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); }
  catch { try { child.kill(signal); } catch { /* Already exited. */ } }
}

function trackedSpawn(allowCancelled: boolean): typeof Bun.spawn {
  return new Proxy(Bun.spawn, {
    apply(target, receiver, args) {
      if (!allowCancelled) throwIfCancelled();
      const invocation = current.getStore();
      if (invocation && process.platform !== "win32") {
        args = Array.isArray(args[0]) ? [args[0], { ...args[1], detached: true }] : [{ ...args[0], detached: true }];
      }
      const child = Reflect.apply(target, receiver, args) as Bun.Subprocess;
      if (invocation) {
        invocation.children.add(child);
        if (invocation.controller.signal.aborted && process.platform !== "win32") invocation.cancelledGroups.add(child.pid);
        // Cleanup may start after the invocation's first child-kill timer fired.
        const timer = invocation.controller.signal.aborted ? setTimeout(() => {
          killChild(child, "SIGKILL");
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
function trackedTemporary(allowCancelled: boolean): typeof nativeMkdtemp { return new Proxy(nativeMkdtemp, {
  async apply(target, receiver, args) {
    if (!allowCancelled) throwIfCancelled();
    const directory = await Reflect.apply(target, receiver, args);
    current.getStore()?.directories.add(String(directory));
    return directory;
  },
}); }
export const mkdtemp = trackedTemporary(false);
/** Failure reports may still need an atomic temporary file after cancellation. */
export const cleanupMkdtemp = trackedTemporary(true);

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
  const invocation: Invocation = { controller: new AbortController(), children: new Set(), cancelledGroups: new Set(), directories: new Set() };
  let exit: number | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    if (exit !== undefined) return;
    exit = signal === "SIGINT" ? 130 : 143;
    invocation.controller.abort(new Error(`Build cancelled by ${signal}`));
    for (const child of invocation.children) {
      if (process.platform !== "win32") invocation.cancelledGroups.add(child.pid);
      killChild(child, "SIGTERM");
    }
    killTimer = setTimeout(() => {
      for (const child of invocation.children) { killChild(child, "SIGKILL"); }
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
          // A leader can exit on TERM while a helper in its group ignores it.
          // Reap direct children first, then wait for the cancelled groups to vanish.
          for (const pid of invocation.cancelledGroups) {
            try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
          while (invocation.cancelledGroups.size) {
            for (const pid of invocation.cancelledGroups) {
              try { process.kill(-pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") invocation.cancelledGroups.delete(pid); else throw error; }
            }
            if (invocation.cancelledGroups.size) await new Promise((resolve) => setTimeout(resolve, 10));
          }
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
