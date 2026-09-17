import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp as nativeMkdtemp, rm } from "node:fs/promises";

interface Invocation {
  controller: AbortController;
  children: Set<Bun.Subprocess>;
  cleanup: Set<Bun.Subprocess>;
  cancelledGroups: Set<number>;
  directories: Set<string>;
}
const current = new AsyncLocalStorage<Invocation>();
interface AbortScope { signal: AbortSignal; draining: Set<Promise<unknown>>; detach: Set<() => void>; cleanups: (() => Promise<unknown>)[] }
const scopes = new AsyncLocalStorage<AbortScope>();

/** Cancel a cooperating task group without aborting its enclosing invocation or
 * unrelated library calls. Child processes are terminated and drained before return. */
export async function runAbortScope<T>(task: (abort: (reason: unknown) => void) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const scope: AbortScope = { signal: invocationSignal(controller.signal)!, draining: new Set(), detach: new Set(), cleanups: [] };
  return scopes.run(scope, async () => {
    let failed = false;
    try { return await task((reason) => controller.abort(reason)); }
    catch (error) { failed = true; controller.abort(error); throw error; }
    finally {
      try {
        await Promise.all([...scope.draining]);
        const cleanup = await Promise.allSettled(scope.cleanups.map((remove) => remove()));
        if (cleanup.some((result) => result.status === "rejected")) throw new Error("Some task scratch could not be removed");
      } catch (error) {
        if (!failed) throw error;
        process.stderr.write("bunko: task cleanup could not complete; scratch may be retained\n");
      } finally { for (const detach of scope.detach) detach(); }
    }
  });
}

/** A callback's finally runs before its rejection can cancel siblings. Defer
 * subprocess scratch cleanup until the whole group has drained, including the
 * first failing callback. Outside a group preserve immediate cleanup. */
export async function cleanupAfterTasks(cleanup: () => Promise<unknown>): Promise<void> {
  const scope = scopes.getStore();
  if (scope) scope.cleanups.push(cleanup);
  else await cleanup();
}

async function killAndDrainGroup(child: Bun.Subprocess): Promise<void> {
  killChild(child, "SIGKILL");
  await child.exited;
  if (process.platform === "win32") return;
  for (;;) {
    try { process.kill(-child.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    // A still-live group must retain scratch. CLI hard cancellation remains the
    // escape hatch when the OS cannot reap it; do not race cleanup against it.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Library calls outside a CLI invocation retain their existing behavior. */
export function throwIfCancelled(): void { invocationSignal()?.throwIfAborted(); }
export function invocationSignal(signal?: AbortSignal | null): AbortSignal | undefined {
  const own = scopes.getStore()?.signal ?? current.getStore()?.controller.signal;
  return own && signal ? AbortSignal.any([own, signal]) : own ?? signal ?? undefined;
}

function killChild(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  // Each CLI-owned process starts a new group on Unix, so its helpers receive the
  // same signal. Outside an invocation or task scope, group behavior is unchanged.
  try { if (process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); }
  catch { try { child.kill(signal); } catch { /* Already exited. */ } }
}

function trackedSpawn(allowCancelled: boolean): typeof Bun.spawn {
  return new Proxy(Bun.spawn, {
    apply(target, receiver, args) {
      if (!allowCancelled) throwIfCancelled();
      const invocation = current.getStore(), scope = scopes.getStore();
      if ((invocation || scope) && process.platform !== "win32") {
        args = Array.isArray(args[0]) ? [args[0], { ...args[1], detached: true }] : [{ ...args[0], detached: true }];
      }
      const child = Reflect.apply(target, receiver, args) as Bun.Subprocess;
      if (scope && !allowCancelled) {
        const abort = () => {
          killChild(child, "SIGTERM");
          // Keep escalation after the leader exits: descendants can retain pipes.
          const escalation = new Promise<void>((resolve) => setTimeout(resolve, 1000)).then(() => killAndDrainGroup(child));
          scope.draining.add(escalation); scope.draining.add(child.exited);
        };
        scope.signal.addEventListener("abort", abort, { once: true });
        if (scope.signal.aborted) abort();
        // A leader may exit while descendants retain output pipes. Keep group
        // cancellation until the cooperating tasks finish draining those pipes.
        scope.detach.add(() => scope.signal.removeEventListener("abort", abort));
      }
      if (invocation) {
        invocation.children.add(child);
        if (allowCancelled) invocation.cleanup.add(child);
        if (invocation.controller.signal.aborted && process.platform !== "win32") invocation.cancelledGroups.add(child.pid);
        // Cleanup may start after the invocation's first child-kill timer fired.
        const timer = allowCancelled ? setTimeout(() => {
          killChild(child, "SIGKILL");
        }, 5000) : undefined;
        void child.exited.finally(() => { clearTimeout(timer); invocation.children.delete(child); invocation.cleanup.delete(child); }).catch(() => {});
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
  const invocation: Invocation = { controller: new AbortController(), children: new Set(), cleanup: new Set(), cancelledGroups: new Set(), directories: new Set() };
  let exit: number | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    if (exit !== undefined) return;
    exit = signal === "SIGINT" ? 130 : 143;
    invocation.controller.abort(new Error(`Build cancelled by ${signal}`));
    for (const child of invocation.children) {
      if (process.platform !== "win32") invocation.cancelledGroups.add(child.pid);
      if (!invocation.cleanup.has(child)) killChild(child, "SIGTERM");
    }
    killTimer = setTimeout(() => {
      for (const child of invocation.children) if (!invocation.cleanup.has(child)) { killChild(child, "SIGKILL"); }
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
            try { process.kill(-pid, "SIGKILL"); } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code !== "ESRCH" && code !== "EPERM") throw error;
            }
          }
          while (invocation.cancelledGroups.size) {
            for (const pid of invocation.cancelledGroups) {
              try { process.kill(-pid, 0); } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ESRCH") invocation.cancelledGroups.delete(pid);
                // macOS can report EPERM while an orphaned group is disappearing.
                // It is not proof of exit: keep polling, or retain scratch at the deadline.
                else if (code !== "EPERM") throw error;
              }
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

/** Bound both process exit and pipe readers, including a child that ignores SIGTERM. */
export async function runWithDeadline<T>(child: Bun.Subprocess, work: Promise<T>, milliseconds: number, label: string, graceMs = 1000): Promise<T> {
  let expired = false, escalation: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      killChild(child, "SIGTERM");
      escalation = setTimeout(() => killChild(child, "SIGKILL"), graceMs);
      reject(new Error(`${label} timed out after ${milliseconds}ms`));
    }, milliseconds);
  });
  try { return await Promise.race([work, timeout]); }
  finally {
    clearTimeout(timer);
    if (expired) {
      // Keep escalation even if the leader exits while descendants retain a pipe.
      await new Promise((resolve) => setTimeout(resolve, graceMs));
      clearTimeout(escalation); killChild(child, "SIGKILL");
    }
  }
}
