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
| Browser | `MAX_POLL_ATTEMPTS` | `services/windbgService.ts` | 60 → **600s** poll budget |
| Browser | `WINDBG_TOTAL_TIMEOUT_MS` | `services/windbgService.ts` | **660s** hard cap on polling + download, armed when the upload answers |
| Browser | `uploadPhaseBudgetMs(size)` | `services/windbgService.ts` | upload-phase hard cap: 660s + file size at `MIN_UPLOAD_BYTES_PER_SECOND` (32 KiB/s) |
| Browser | `UPLOAD_INACTIVITY_TIMEOUT_MS` | `services/windbgService.ts` | 60s without upload progress |
| Browser | `UPLOAD_RESPONSE_TIMEOUT_MS` | `services/windbgService.ts` | 300s from the body being sent to the upload response |
| Fastify | `WINDBG_UPLOAD_RESPONSE_BUDGET_MS` | `server.js` / `server/windbgUploadSubmit.js` | **90s** browser upload response (max 95s, under Cloudflare's 100s) |
| Fastify | `WINDBG_UPLOAD_TIMEOUT_MS` | `server.js` | 240s (per submit→C#, runs on past the response budget; effectively ~100s, see below: the submit to WinDbg-API also crosses Cloudflare) |
| Fastify | `WINDBG_POLL_TIMEOUT_MS` | `server.js` | 20s (per status→C#) |
| Fastify | `WINDBG_DOWNLOAD_TIMEOUT_MS` | `server.js` | 60s (per download→C#) |
| C# | `MAX_JOB_DURATION` | `WinDbgApiConfig` | 360s (cdb run cap) |
| C# | `WatchdogGraceSeconds` | `WinDbgApiConfig.Queue` | 60s |
| C# | watchdog kill | `MAX_JOB_DURATION + grace` | **420s** |

## Browser budget vs. server terminal time

The browser used to abandon the job at 300s while the C# server could still finish a
kernel dump at 360s or reach its watchdog `timed_out` at 420s. That gap is closed on the
browser side (the "patient" option below): once the upload answers, the browser polls for
up to 600s and has 660s for polling plus download, so a job that starts running promptly
reaches its terminal state (success at <= 360s, or `timed_out` at 420s) while the browser
is still polling. The upload itself is bounded separately, by inactivity (60s), by the
300s wait for the upload response after the body is sent, and by the size-scaled
upload-phase cap; the server answers the upload within its 90s response budget
(see below).

What remains: queue wait upstream counts against the 600s poll budget. A job that waits
more than about 180s in the WinDbg-API queue before cdb starts can still be abandoned
before the server's 420s terminal decision, and the browser falls back to local analysis.
The analysis cache is off (`redis.cfg` = `disabled`), so a re-upload of the same file
submits a new job rather than picking up the finished one.

## Options considered

- **Snappier: shrink the server cap.** Set `MAX_JOB_DURATION=240`,
  `WatchdogGraceSeconds=30` → watchdog kill at **270s**, with a matching shorter browser
  budget.
- **Patient: grow the browser budget (implemented).** Keep `MAX_JOB_DURATION=360`/grace 60
  (kill 420s) and give the browser a poll budget above it (now 600s, 660s with download),
  so it observes the server's terminal decision (success *or* `timed_out`) instead of
  abandoning it.

In both cases the invariant is: **browser budget ≥ server terminal time + one poll interval +
download time**, and `WINDBG_POLL_TIMEOUT_MS` (per status call) stays well under
`POLL_INTERVAL_MS` so a slow status call fails fast and the next poll retries with fresh state.

## Already implemented (this change set)

- The browser poll loop fails fast on a terminal upstream status (`failed`/`timed_out`)
  instead of waiting out the clock, and surfaces the server's `error`/`error_category`
  (`services/windbgService.ts`, `shared/windbgApiClient.js`).
- Unknown/unmapped upstream statuses are passed through as `raw_status` rather than being
  silently treated as `pending` forever.

> Changing the C# values is a coordinated, deploy-time change across both repos and a UX
> call on acceptable wait time. Update this table and both code sites together.

## Upload submit vs. the Cloudflare edge (issue #276)

Cloudflare drops an origin response at 100s, and the signed file handle the browser
needs to poll a job only ships in the `/api/windbg/upload` response. The route therefore
answers within `WINDBG_UPLOAD_RESPONSE_BUDGET_MS` (default 90s): a slower submit gets a
JSON `504` with `code: "WINDBG_UPLOAD_TIMEOUT"`, `retryable: true` and `Retry-After: 15`.
The upstream submit keeps running (up to `WINDBG_UPLOAD_TIMEOUT_MS`), and a retry of the
same dump on the same instance joins it or adopts the job it created (once, within the
ownership window) instead of submitting again. WinDbg-API has no idempotency key or
file-hash dedupe, so a retry that lands on another instance submits a fresh job; the late
job is then only logged (`windbg.upload.late_job`). No upstream job reference is returned
in the 504: none exists yet when the budget runs out.

The submit to WinDbg-API is itself proxied by Cloudflare (`windbg-api.stack-tech.net`), whose
default origin response timeout is also 100s (the zone's plan, and so whether it was raised, is
unconfirmed; issue #342). A submit WinDbg-API has not answered by then gets a Cloudflare `524` at
about 100s, which is classified as unconfirmed (below): no adopt, and the dump is held on that
instance. So the 240s `WINDBG_UPLOAD_TIMEOUT_MS` and the join/adopt path only cover submits that
finish within ~90-100s; a longer cap buys nothing unless that edge timeout is raised or bypassed.
The browser (`services/windbgService.ts`) retries that 504, the transient gateway failures
(`WINDBG_UPLOAD_TRANSIENT`) and any answer marked `retryable: true` at most twice, after
`Retry-After` (15 s when absent, capped at 30 s), inside its upload-phase budget (issue #307):
at most three uploads per analysis for these answers, `WINDBG_UPLOAD_RETRY_LATER` included. The
busy budget below is keyed on the `WINDBG_UPLOAD_BUSY` code only, never on the message text
(issue #344: the retry-later wording "server is busy" used to spend both budgets, five uploads).
With the server's own single re-POST of a retryable upstream submit failure, one browser
analysis sends WinDbg-API at most six full-dump POSTs.
Other upload failures say whether a retry can help (issues #325, #327). The upstream status of a
failed submit is classified once, in `server/windbgSubmitFailure.js`, for both the upload route
(`server/windbgUploadFailure.js`) and `/api/analyze` (`server/externalJobs.js`):

| Upstream submit answer | Upload route | `/api/analyze` |
|---|---|---|
| 400, 413, 415, 422 (the file was refused) | `422` `WINDBG_UPLOAD_REJECTED`, `retryable: false` | `422` `DUMP_REJECTED` |
| 408, 409, 423, 425, 429, 507, 503 with `Retry-After` (nothing taken, come back later) | `503` `WINDBG_UPLOAD_RETRY_LATER`, `retryable: true`, `Retry-After` 15-30 s (30 s for 507, "temporarily out of space") | `503` `ANALYSIS_RETRY_LATER`, same `Retry-After` |
| 429 with `Retry-After` over 30 s, or a per-key quota 429 (`RATE_LIMITED`, or "Rate limit exceeded for this API key") without one (issue #340) | `503` `WINDBG_UPLOAD_LIMITED`, `retryable: false`, "reached its analysis limit", the upstream `Retry-After` when sent; the browser analyzes locally | `503` `ANALYSIS_LIMITED`, `retryable: false`, same `Retry-After` |
| ECONNREFUSED, ENOTFOUND, EAI_AGAIN (connection never established); Cloudflare 521, 523, 525, 526 (the edge never delivered the request, issue #335) | `502` `WINDBG_UPLOAD_UNREACHABLE`, `retryable: true`, `Retry-After: 15` | `503` `ANALYSIS_RETRY_LATER` |
| 401, 403, 407 (our credentials or proxy) and any other 4xx | `502` `WINDBG_UPLOAD_FAILED`, `retryable: false`, does not blame the file | `500` `ANALYSIS_INIT_FAILED` |
| any other 5xx (500, 502, 503 without `Retry-After`, 504, Cloudflare 520/522/524/530...), a 2xx with invalid JSON or no job id, a timeout, a connection lost mid-request (any reset, even one during connect) | `502` (`504` for a timeout) `WINDBG_UPLOAD_UNCONFIRMED`, `retryable: false`, "may still be processing it" | `502` `ANALYSIS_INIT_FAILED`, `retryable: false` (issue #334; the timeout is answered by the response budget below) |
| a failure on this side, before any upstream request | `500`, no code | `500` `ANALYSIS_INIT_FAILED` |

A connection reset counts as unconfirmed even when it happens while connecting: undici does not
report whether any request byte reached WinDbg-API, so only ECONNREFUSED, ENOTFOUND and EAI_AGAIN
prove that nothing was sent. Cloudflare's 521 (origin refused the connection), 523 (origin
unreachable), 525 (TLS handshake with the origin failed) and 526 (invalid origin certificate) prove
the same, so they are retryable and the submit helper re-POSTs them once (issue #335): a WinDbg-API
restart no longer fails every upload hard and holds the dump. 522 stays unconfirmed: Cloudflare also
sends it when the connection was established and the origin did not acknowledge the already-sent
request within 90 s, and the edge page does not say which case it was. 520 and 524 follow a
delivered request. The status poll retries every Cloudflare 520-526 (`isTransientUpstreamStatus`).

The browser's status poll and download (`GET /api/windbg/status`, `GET /api/windbg/download`) are
idempotent reads of an existing job. A garbled or failing upstream answer and a connection reset or
refused on the way to WinDbg-API answer `502` (`WINDBG_UPSTREAM_*`, `WINDBG_UPSTREAM_UNREACHABLE`
for the connection), a timeout `504` `WINDBG_UPSTREAM_TIMEOUT`, so the browser retries the poll
(429/502/503/504, `services/windbgService.ts`); only a local failure is a `500` `INTERNAL_ERROR`
(issue #334, `winDbgUpstreamHttpStatus` / `winDbgUpstreamFailureCode` in
`server/windbgUploadFailure.js`).

Only the outcomes that guarantee no job was created are retryable (issue #328, the rule
`isRetryableSubmitError` already applies inside the submit helper since #140): WinDbg-API has no
idempotency key or file-hash dedupe, and a 502/504/520/522/524, a garbled 2xx or a timeout can follow an
upload it already queued, so a browser re-upload would queue a second cdb job. Such an
*unconfirmed* failure, within the response budget or after the `504` `WINDBG_UPLOAD_TIMEOUT`
answer, also holds the file hash on that instance for 10 minutes (`DEFAULT_UNCONFIRMED_HOLD_MS` in
`server/windbgUploadSubmit.js`, about one WinDbg-API job lifetime; successful results stay adoptable
for the longer ownership window, `OWNERSHIP_EXPIRY`): a re-run of the same dump there is answered from the adopt record
when the late submit did return a job, and otherwise gets `409` `WINDBG_UPLOAD_PENDING`
(`retryable: false`, "may still be processing there") without a submit, so the browser falls back
to local analysis. The hold is per-instance memory, like join/adopt. `/api/analyze` holds the
file hash the same way for 10 minutes (issue #336; its submitter keeps no results, `retainMs: 0`,
so the hold is passed explicitly by `createExternalWinDbgSubmitter`): the ambiguous failure itself
answers `502` `ANALYSIS_INIT_FAILED` with `retryable: false`, and a resubmission of the same dump on
that instance within the hold gets `409` `ANALYSIS_PENDING` (`retryable: false`, `Retry-After` = the
rest of the hold) without a submit. A resubmission on another instance still submits.

WinDbg-API's own submit answers are 202, 400, 401, 413, 429 (queue full, per-key limit) and 507
(storage pressure, refused before a job record exists). The two 429s differ (issue #340): a full
queue clears in seconds, an exhausted per-key quota (30 per hour by default) does not. The submit
helper re-POSTs a 429 once only when it carries no quota signal (`error_code`/`code`
`RATE_LIMITED`, or the per-key text) and no `Retry-After` over 5 s, after the upstream
`Retry-After` (750 ms when absent); the same `Retry-After` rule applies to a 503. A plain 429 with
neither signal keeps the retryable 503 `WINDBG_UPLOAD_RETRY_LATER` with `Retry-After: 15`. Only `WINDBG_UPLOAD_REJECTED` text may call
the dump rejected in the AI fallback prompt (`describeWinDbgFailureForPrompt`). A JSON gateway 5xx
without a code counts as `WINDBG_UPLOAD_TRANSIENT` only when it says `retryable: true`; one without a
JSON body (an edge page) always does.

A submit answered with the 504 no longer holds the route's concurrency slot but still holds
the dump in memory, so submits still running count against the same per-instance cap of two
as the route (issue #314): a new dump past it gets `429` `WINDBG_UPLOAD_BUSY` with
`Retry-After: 15` and is not submitted; a retry that joins or adopts its own submit is
still served. The cap is checked before the upload limiters and before the body is read
(`createWinDbgUploadCapGate`, issue #338), so a refused dump is not transferred and spends no
limiter slot. The hash is only known after the body, so the browser sends its SHA-256 as an
advisory `X-File-Hash` header and the gate lets a request through at the cap when that hash is
running or adoptable on this instance; the handler still hashes the body and the submitter
re-checks the cap with that hash, so a wrong header only gets the old post-body refusal, and a
request without the header is refused at the cap. The browser waits for `Retry-After` on a busy
(`WINDBG_UPLOAD_BUSY`) answer too (at most twice, like the retryable answers; the two budgets are
separate, so a run that meets both kinds can upload up to five times), and falls back to local analysis at once
when the wait cannot end inside its upload-phase budget.

`/api/analyze` submits go through the same budget (issue #315): a slower submit answers
`504` `WINDBG_UPLOAD_TIMEOUT` (`retryable: true`, `Retry-After: 15`) and keeps running, and
past the per-instance cap of two running submits the route answers `429` `ANALYSIS_BUSY`.
The submit is registered under the file hash before it is awaited, so a resubmission of the
same dump joins it; when it settles, even after the 504, its signed uid is recorded for the
reuse check, so the next resubmission on this instance gets `202` with a uid for that upstream
job instead of a second one. That uid is signed afresh with the resubmission's own file name, size
and archive name (same upstream job and accept time, issue #330); results are keyed by file hash
and upstream job, so all uids for one job share one resolution, one AI report and one stats and
corpus row. The entry is dropped when the job ends with a degraded report (issue #256)
or fails in a way a new submission may fix (issue #329, `isResubmittableFailure` in
`server/externalJobs.js`): the upstream job failed for any category but `cdb` or `upload` (the
dump itself), the status poll got a permanent 4xx, the deadline passed, the completed job had no
analysis text, or a cache-hit job lost its cache entry. Pollers of the failed uid still get
`failed`; the next resubmission starts a new upstream job.
