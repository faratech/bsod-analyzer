// Regenerates AI reports for historical WinDBG jobs (bsod_corpus.windbg_analyses)
// whose original reports were never stored, and writes them to
// bsod_corpus.ai_reports with origin='regenerated'.
//
// The prompt, provider adapters and validation are the site's own
// (buildWinDbgEvidence + WINDBG_PREFIX, services/aiProvider.js,
// parseAndValidateAnalysisReport), so rows match what the external API would
// have produced for the same WinDBG signal.
//
// Routes are tried in order and each latches off when its budget is spent or the
// provider reports quota exhaustion:
//   openai-incentive  gpt-6-luna, OpenAI data-sharing free tier (stops at the
//                     first billed response or its daily budget)
//   explabs-gpt6      gpt-6-luna, Experiential (paid, discounted) — the remainder
// Concurrency is adaptive per route (additive increase, halve on 429 honoring
// retry-after). Progress is checkpointed so the run can be resumed.
//
//   node scripts/regenerate-ai-reports.mjs --input jobs.ndjson --checkpoint done.txt [--limit N] [--routes a,b]
// jobs.ndjson lines: {"job_id","dump_type","file_size_bytes","ai_signal"}.
// Env: OPENAI_API_KEY, EXPLABS_API_KEY, BQ_PROJECT (default project-bigfoot).
import fs from 'node:fs';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { SYSTEM_INSTRUCTION_ANALYSIS, WINDBG_PREFIX, wrapWithEvidence } from '../shared/promptTemplates.js';
import { extractRelevantWinDbgSignal } from '../shared/windbgApiClient.js';
import { generateExperientialContent, generateOpenAIContent, isOpenAIFreeTier } from '../services/aiProvider.js';
import { buildWinDbgEvidence, parseAndValidateAnalysisReport } from '../server/analysisReport.js';
import { buildAiReportRow, toAiInsertAllRow } from '../server/windbgCorpus.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : 'true'];
}));
const INPUT = args.input;
const CHECKPOINT = args.checkpoint || 'regenerate-done.txt';
const LIMIT = Number(args.limit || Infinity);
const PROJECT = process.env.BQ_PROJECT || 'project-bigfoot';
const MAX_OUTPUT_TOKENS = 16_384;
const REQUEST_TIMEOUT_MS = 240_000;
if (!INPUT) {
  console.error('usage: node scripts/regenerate-ai-reports.mjs --input=jobs.ndjson [--checkpoint=done.txt] [--limit=N] [--routes=...]');
  process.exit(1);
}

// Budgets leave headroom for the live site, which draws on the same free allowances.
const ROUTES = [
  {
    name: 'openai-incentive',
    model: 'gpt-6-luna',
    call: (request, signal) => generateOpenAIContent(request, {
      apiKey: process.env.OPENAI_API_KEY, model: 'gpt-6-luna', signal, maxRetries: 0
    }),
    budget: { total: Number(args['openai-budget'] || 3_000_000) },
    maxConcurrency: Number(args['openai-max-concurrency'] || 64)
  },
  {
    name: 'explabs-gpt6',
    model: 'gpt-6-luna',
    call: (request, signal) => generateExperientialContent(request, {
      apiKey: process.env.EXPLABS_API_KEY, model: 'gpt-6-luna', signal, maxRetries: 0
    }),
    budget: {},
    maxConcurrency: Number(args['gpt6-max-concurrency'] || 256),
    price: { input: 0.025, cached: 0.003, output: 0.13 } // $/M tokens (75% off)
  }
].filter(r => !args.routes || args.routes.split(',').includes(r.name))
  .map(r => ({ ...r, inFlight: 0, limit: 4, active: true, pausedUntil: 0, done: 0, failed: 0, input: 0, output: 0, cached: 0, billed: 0, reason: '' }));

// ---------------------------------------------------------------------------
// BigQuery writer (batched insertAll with a refreshed gcloud token)
// ---------------------------------------------------------------------------
let token = { value: null, at: 0 };
function bqToken() {
  if (!token.value || Date.now() - token.at > 30 * 60_000) {
    token = { value: execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim(), at: Date.now() };
  }
  return token.value;
}
const pendingRows = [];
let flushing = Promise.resolve();
let rowsWritten = 0;
async function insertBatch(rows) {
  const body = JSON.stringify({ rows: rows.map(r => ({ insertId: r.report_id, json: r })) });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/datasets/bsod_corpus/tables/ai_reports/insertAll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bqToken()}`, 'Content-Type': 'application/json' },
      body
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && !out.insertErrors?.length) return;
    if (attempt >= 5) throw new Error(`BigQuery insert failed: ${JSON.stringify(out.insertErrors?.[0] || out.error || res.status).slice(0, 300)}`);
    await new Promise(r => setTimeout(r, 1000 * attempt));
  }
}
function flush(force = false) {
  flushing = flushing.then(async () => {
    while (pendingRows.length && (force || pendingRows.length >= 25)) {
      const batch = [];
      let bytes = 0;
      while (pendingRows.length && batch.length < 50) {
        const size = Buffer.byteLength(JSON.stringify(pendingRows[0]));
        if (batch.length && bytes + size > 8 * 1024 * 1024) break;
        batch.push(pendingRows.shift());
        bytes += size;
      }
      await insertBatch(batch.map(b => b.row));
      rowsWritten += batch.length;
      fs.appendFileSync(CHECKPOINT, batch.map(b => b.jobId).join('\n') + '\n');
    }
  });
  return flushing;
}

// ---------------------------------------------------------------------------
// Job handling
// ---------------------------------------------------------------------------
function buildRequest(job) {
  const structured = extractRelevantWinDbgSignal({ result: { ai_signal: job.ai_signal } });
  if (!structured || Object.keys(structured).length === 0) return null;
  const analysisForPrompt = JSON.stringify(structured, null, 2);
  const evidence = buildWinDbgEvidence({
    fileName: 'crash.dmp',
    dumpType: job.dump_type || 'unknown',
    fileSize: job.file_size_bytes || 0,
    analysisForPrompt,
    structured: true
  });
  const prompt = wrapWithEvidence(WINDBG_PREFIX, evidence);
  return {
    prompt,
    request: {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.5,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        systemInstruction: SYSTEM_INSTRUCTION_ANALYSIS
      }
    }
  };
}

function overBudget(route) {
  const b = route.budget;
  if (b.total && route.input + route.output >= b.total) return 'budget reached';
  if (b.input && route.input >= b.input) return 'input budget reached';
  if (b.output && route.output >= b.output) return 'output budget reached';
  return '';
}

function latch(route, reason) {
  if (!route.active) return;
  route.active = false;
  route.reason = reason;
  console.log(`[route] ${route.name} off: ${reason}`);
}

const retryQueue = [];
let noSignal = 0;
let invalid = 0;

async function runJob(route, job, built) {
  route.inFlight++;
  try {
    const response = await route.call(built.request, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    const usage = response.usageMetadata || {};
    route.input += usage.promptTokenCount || 0;
    route.output += usage.candidatesTokenCount || 0;
    route.cached += usage.cachedContentTokenCount || 0;
    if (route.name === 'openai-incentive' && !isOpenAIFreeTier(response.serviceTier)) {
      route.billed++;
      latch(route, `billed response (service_tier=${response.serviceTier})`);
    }
    const reason = overBudget(route);
    if (reason) latch(route, reason);
    route.limit = Math.min(route.maxConcurrency, route.limit + 1);

    const validation = parseAndValidateAnalysisReport(response.text ?? '');
    if (!validation.valid) {
      job.attempts = (job.attempts || 0) + 1;
      if (job.attempts < 2) retryQueue.push(job); else { invalid++; route.failed++; }
      return;
    }
    const row = toAiInsertAllRow(buildAiReportRow({
      origin: 'regenerated',
      source: 'windbg',
      promptType: 'windbg',
      jobId: job.job_id,
      provider: route.name.startsWith('openai') ? 'openai' : 'experiential',
      model: route.model,
      modelVersion: response.modelVersion,
      serviceTier: response.serviceTier,
      route: route.name,
      promptText: built.prompt,
      responseText: response.text,
      report: validation.report,
      usage: { ...usage, serviceTier: response.serviceTier ?? null, route: route.name }
    }, { reportId: randomUUID() }));
    pendingRows.push({ row, jobId: job.job_id });
    route.done++;
    if (pendingRows.length >= 25) flush();
  } catch (error) {
    const status = error?.status;
    const message = String(error?.message || error);
    const quota = status === 402 || /quota|credit|exhaust|insufficient|billing/i.test(message);
    if (status === 401 || status === 403 || quota) {
      latch(route, `${status || ''} ${message}`.trim().slice(0, 200));
      retryQueue.push(job);
    } else if (status === 429) {
      route.limit = Math.max(1, Math.floor(route.limit / 2));
      const wait = Number(error?.retryAfterMs) || 5000;
      route.pausedUntil = Date.now() + wait;
      retryQueue.push(job);
    } else {
      job.attempts = (job.attempts || 0) + 1;
      if (job.attempts < 3) retryQueue.push(job); else { route.failed++; console.warn(`[job] ${job.job_id} failed: ${message.slice(0, 160)}`); }
    }
  } finally {
    route.inFlight--;
  }
}

function pickRoute() {
  const now = Date.now();
  for (const route of ROUTES) {
    if (!route.active) continue;
    if (route.pausedUntil > now) return null; // rate-limited: wait rather than spill to a later route
    if (route.inFlight < route.limit) return route;
    return null; // respect route order: don't spill onto a later (paid) route while an earlier one is merely busy
  }
  return null;
}

function costOf(route) {
  if (!route.price) return 0;
  const uncached = Math.max(0, route.input - route.cached);
  return (uncached * route.price.input + route.cached * route.price.cached + route.output * route.price.output) / 1e6;
}

async function main() {
  const done = new Set(fs.existsSync(CHECKPOINT) ? fs.readFileSync(CHECKPOINT, 'utf8').split('\n').filter(Boolean) : []);
  const queue = [];
  const rl = readline.createInterface({ input: fs.createReadStream(INPUT) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const job = JSON.parse(line);
    if (typeof job.ai_signal === 'string') job.ai_signal = JSON.parse(job.ai_signal);
    if (!done.has(job.job_id)) queue.push(job);
    if (queue.length >= LIMIT) break;
  }
  console.log(`jobs to regenerate: ${queue.length} (already done: ${done.size}); routes: ${ROUTES.map(r => r.name).join(', ')}`);

  const started = Date.now();
  const status = setInterval(() => {
    const secs = Math.round((Date.now() - started) / 1000);
    const parts = ROUTES.map(r => `${r.name}${r.active ? '' : '(off)'} done=${r.done} fail=${r.failed} inflight=${r.inFlight}/${r.limit} in=${(r.input / 1e6).toFixed(2)}M out=${(r.output / 1e6).toFixed(2)}M${r.price ? ` $${costOf(r).toFixed(2)}` : ''}`);
    console.log(`[${secs}s] written=${rowsWritten} queued=${queue.length + retryQueue.length} invalid=${invalid} no_signal=${noSignal} | ${parts.join(' | ')}`);
  }, 10_000);

  const running = new Set();
  while (queue.length || retryQueue.length || running.size) {
    if (!ROUTES.some(r => r.active)) { console.log('all routes are off; stopping'); break; }
    const route = (queue.length || retryQueue.length) ? pickRoute() : null;
    if (!route) {
      await Promise.race([...running, new Promise(r => setTimeout(r, 200))]);
      continue;
    }
    const job = retryQueue.shift() || queue.shift();
    const built = buildRequest(job);
    if (!built) { noSignal++; continue; }
    const p = runJob(route, job, built).finally(() => running.delete(p));
    running.add(p);
  }
  await Promise.allSettled([...running]);
  await flush(true);
  clearInterval(status);

  const summary = ROUTES.map(r => ({ route: r.name, model: r.model, done: r.done, failed: r.failed, billed: r.billed,
    input_tokens: r.input, cached_tokens: r.cached, output_tokens: r.output, cost_usd: Number(costOf(r).toFixed(4)), off_reason: r.reason || null }));
  console.log(JSON.stringify({ written: rowsWritten, invalid, no_signal: noSignal, remaining: queue.length + retryQueue.length, routes: summary }, null, 2));
}

main().catch(error => { console.error(error); process.exit(1); });
