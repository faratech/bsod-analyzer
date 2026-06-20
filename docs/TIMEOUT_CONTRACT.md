# WinDBG Timeout Contract

End-to-end timeout budget for the dump-analysis path:

```
Browser ──poll──▶ Fastify (/api/windbg/*) ──▶ C# WinDbg-API ──▶ cdb.exe
```

This doc is the single source of truth for the timeout values in **both** repos
(`bsod-analyzer` and `windbg-server`). Keep them coherent: an inner layer must not give
up before the layer it depends on has reached a terminal decision.

## Current values

| Layer | Constant | Where | Value |
|-------|----------|-------|-------|
| Browser | `POLL_INTERVAL_MS` | `services/windbgService.ts` | 10s |
| Browser | `MAX_POLL_ATTEMPTS` | `services/windbgService.ts` | 30 → **300s** poll budget |
| Browser | `WINDBG_TOTAL_TIMEOUT_MS` | `services/windbgService.ts` | **300s** hard cap |
| Fastify | `WINDBG_UPLOAD_TIMEOUT_MS` | `server.js` | 120s (per upload→C#) |
| Fastify | `WINDBG_POLL_TIMEOUT_MS` | `server.js` | 20s (per status→C#) |
| Fastify | `WINDBG_DOWNLOAD_TIMEOUT_MS` | `server.js` | 60s (per download→C#) |
| C# | `MAX_JOB_DURATION` | `WinDbgApiConfig` | 360s (cdb run cap) |
| C# | `WatchdogGraceSeconds` | `WinDbgApiConfig.Queue` | 60s |
| C# | watchdog kill | `MAX_JOB_DURATION + grace` | **420s** |

## The incoherence

The browser abandons the job at **300s**, but the C# server may still be running a kernel
dump until **360s** (success) or be killed by the watchdog at **420s** (terminal `timed_out`).
A job that finishes at 300–360s succeeds server-side, yet the polling session already gave up
and fell back to local analysis. (The result is still cached by file-hash, so a *re-upload*
of the same file hits the cache — but the original session wasted the work.)

## Recommended target

Pick **one** of these coherent budgets (a product/ops decision on how long a user waits):

- **Snappier (recommended): shrink the server cap.** Set `MAX_JOB_DURATION=240`,
  `WatchdogGraceSeconds=30` → watchdog kill at **270s**. Browser hard cap **290s** (≈30
  attempts × 10s), giving a ~20s margin for the final poll + download. Users wait ≤ ~5 min.
- **Patient: grow the browser budget.** Keep `MAX_JOB_DURATION=360`/grace 60 (kill 420s).
  Raise the browser `MAX_POLL_ATTEMPTS`/`WINDBG_TOTAL_TIMEOUT_MS` to ~**450s** so the browser
  observes the server's terminal decision (success *or* `timed_out`) instead of abandoning it.

In both cases the invariant is: **browser budget ≥ server terminal time + one poll interval +
download time**, and `WINDBG_POLL_TIMEOUT_MS` (per status call) stays well under
`POLL_INTERVAL_MS` so a slow status call fails fast and the next poll retries with fresh state.

## Already implemented (this change set)

- The browser poll loop fails fast on a terminal upstream status (`failed`/`timed_out`)
  instead of waiting out the clock, and surfaces the server's `error`/`error_category`
  (`services/windbgService.ts`, `shared/windbgApiClient.js`).
- Unknown/unmapped upstream statuses are passed through as `raw_status` rather than being
  silently treated as `pending` forever.

> Changing the numeric values above is intentionally left as a follow-up: it is a coordinated,
> deploy-time change across both repos and a UX call on acceptable wait time. Update this table
> and both code sites together.
