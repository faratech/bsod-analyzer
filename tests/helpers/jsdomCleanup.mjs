// Cleanup for the jsdom component tests (issue #321).
//
// A mounted React root keeps its component's timers (setInterval polls,
// elapsed-time clocks) alive until it is unmounted. When a test unmounted only
// after its last assertion, a failing assertion skipped the unmount, the
// timers kept the test file's process alive and `npm test` hung instead of
// reporting the failure.
import { afterEach } from 'node:test';

// Returns track(unmount): wraps an unmount function so it runs at most once
// and is run by an afterEach hook if the test did not (because it failed or
// threw). Call createMountTracker() once at the top level of a test file.
export function createMountTracker() {
  const live = new Set();
  afterEach(async () => {
    for (const unmount of [...live]) await unmount();
  });
  return function track(unmount) {
    let done = false;
    const once = async () => {
      if (done) return;
      done = true;
      live.delete(once);
      await unmount();
    };
    live.add(once);
    return once;
  };
}

// Per-file safety net: if a leaked handle still keeps the file alive after
// `ms`, fail the file instead of hanging the whole run. The timer is unref'd,
// so it never holds a healthy file open.
export function failFileAfter(ms, name) {
  const timer = setTimeout(() => {
    console.error(`${name}: still running after ${ms} ms (a leaked timer or handle?); failing the file`);
    process.exit(1);
  }, ms);
  timer.unref();
}

export const JSDOM_FILE_TIMEOUT_MS = 120_000;
