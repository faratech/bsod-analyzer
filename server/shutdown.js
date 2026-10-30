// Graceful shutdown on SIGTERM/SIGINT (issue #368).
//
// Cloud Run sends SIGTERM on scale-in and on every revision rollover and
// SIGKILLs the instance 10 s later. Without a handler Node exits at once, which
// cut every in-flight request: a /api/windbg/upload whose upstream job was
// already created never returned the signed handle, so nobody polled the job
// and the browser's retry queued a second one on another instance.
//
// On the first signal the coordinator stops accepting connections (`close`,
// the compat app's fastify.close(): new requests on open keep-alive sockets
// get Fastify's 503 + Connection: close), keeps reaping keep-alive sockets
// that go idle after their in-flight response (Node only closes the ones idle
// at close time; h2c sessions get GOAWAY from Node >= 24's server.close()
// itself, after their open streams), lets in-flight requests finish within `graceMs`, runs the
// optional drains in what is left of it and exits 0. Anything still running at
// the grace exits 1; a hard timer at `forceMs` (below Cloud Run's 10 s) exits
// even if the run itself stalls. A second signal reuses the first run.
//
// /health is left alone: Cloud Run stops routing to an instance once it sends
// SIGTERM, so a draining state on the probe would change nothing.

export const DEFAULT_SHUTDOWN_GRACE_MS = 8_000;
export const DEFAULT_SHUTDOWN_FORCE_MS = 9_000;
const IDLE_SWEEP_MS = 100;

export function createShutdownCoordinator({
  close,
  server = null,
  drains = [],
  exit = code => process.exit(code),
  log = console,
  graceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  forceMs = DEFAULT_SHUTDOWN_FORCE_MS,
  now = Date.now
}) {
  let run = null;
  let exited = false;
  let installed = false;

  function exitOnce(code) {
    if (exited) return;
    exited = true;
    exit(code);
  }

  // Resolves true when `promise` settles within `ms`, false otherwise; a
  // rejection counts as settled (logged), never as a reason to skip exit.
  function within(promise, ms, what) {
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve(false), Math.max(0, ms));
    });
    const settled = Promise.resolve()
      .then(() => promise)
      .then(
        () => true,
        error => {
          log.warn('shutdown.step_failed', { step: what, error: error?.message || String(error) });
          return true;
        }
      );
    return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
  }

  async function runShutdown(signal) {
    const started = now();
    log.info('shutdown.start', { signal, graceMs });
    const force = setTimeout(() => {
      log.warn('shutdown.forced', { signal, afterMs: now() - started });
      exitOnce(1);
    }, forceMs);
    force.unref?.();
    const sweep = setInterval(() => server?.closeIdleConnections?.(), IDLE_SWEEP_MS);
    sweep.unref?.();

    try {
      let clean = await within(close(), graceMs, 'close');
      for (const drain of drains) {
        if (!clean) break;
        clean = await within(drain(), graceMs - (now() - started), 'drain');
      }
      if (!clean) log.warn('shutdown.grace_exceeded', { signal, graceMs });
      else log.info('shutdown.done', { signal, ms: now() - started });
      exitOnce(clean ? 0 : 1);
    } finally {
      clearInterval(sweep);
      clearTimeout(force);
    }
  }

  function shutdown(signal) {
    if (!run) run = runShutdown(signal);
    else log.info('shutdown.signal_ignored', { signal });
    return run;
  }

  function install(proc = process, signals = ['SIGTERM', 'SIGINT']) {
    if (installed) return;
    installed = true;
    for (const signal of signals) proc.on(signal, () => { shutdown(signal); });
  }

  return { shutdown, install, isDraining: () => run !== null };
}
