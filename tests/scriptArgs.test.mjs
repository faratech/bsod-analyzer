import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, ArgsError } from '../scripts/lib/args.mjs';

const REGENERATE_SPEC = {
  flags: {
    input: { type: 'string' },
    checkpoint: { type: 'string' },
    limit: { type: 'positiveInteger' },
    routes: { type: 'list', choices: ['openai-incentive', 'explabs-gpt6'] },
    'openai-budget': { type: 'nonNegativeNumber' },
  },
};

test('the documented space-separated invocation sets the limit (issue #375)', () => {
  const { flags } = parseArgs(['--input', 'jobs.ndjson', '--checkpoint', 'done.txt', '--limit', '5'], REGENERATE_SPEC);
  assert.deepEqual(flags, { input: 'jobs.ndjson', checkpoint: 'done.txt', limit: 5 });
});

test('--k=v and --k v forms are equivalent (issue #375)', () => {
  const eq = parseArgs(['--input=a b.ndjson', '--limit=5', '--routes=explabs-gpt6', '--openai-budget=0'], REGENERATE_SPEC).flags;
  const sp = parseArgs(['--input', 'a b.ndjson', '--limit', '5', '--routes', 'explabs-gpt6', '--openai-budget', '0'], REGENERATE_SPEC).flags;
  assert.deepEqual(eq, sp);
  assert.deepEqual(eq, { input: 'a b.ndjson', limit: 5, routes: ['explabs-gpt6'], 'openai-budget': 0 });
  assert.equal(parseArgs(['--input=x=y'], REGENERATE_SPEC).flags.input, 'x=y');
});

test('invalid, unknown, missing and repeated arguments throw (issue #375)', () => {
  const bad = [
    ['--limit', 'abc'],
    ['--limit', '0'],
    ['--limit', '1.5'],
    ['--limit', '-3'],
    ['--limit=1e3'],
    ['--limit'],
    ['--limit', '--input', 'x'],
    ['--openai-budget', '-1'],
    ['--openai-budget', 'NaN'],
    ['--openai-budget', 'Infinity'],
    ['--limt=5'],
    ['jobs.ndjson'],
    ['--input', 'a', 'stray'],
    ['--routes', 'explabs-gpt6,typo'],
    ['--routes='],
    ['--input=a', '--input=b'],
    ['-limit', '5'],
  ];
  for (const argv of bad) {
    assert.throws(() => parseArgs(argv, REGENERATE_SPEC), ArgsError, argv.join(' '));
  }
});

test('boolean flags take no value and positionals are counted (issue #375)', () => {
  const spec = { flags: { apply: { type: 'boolean' }, before: { type: 'string' } }, positionals: 1 };
  assert.deepEqual(parseArgs(['--apply', 'file.jsonl', '--before', 'T'], spec), {
    flags: { apply: true, before: 'T' }, positionals: ['file.jsonl'],
  });
  assert.throws(() => parseArgs(['--apply=yes'], spec), ArgsError);
  assert.throws(() => parseArgs(['a', 'b'], spec), ArgsError);
});

test('regenerate-ai-reports exits 1 with usage on an invalid limit before doing any work (issue #375)', () => {
  const script = fileURLToPath(new URL('../scripts/regenerate-ai-reports.mjs', import.meta.url));
  const env = { ...process.env, OPENAI_API_KEY: '', EXPLABS_API_KEY: '', PATH: process.env.PATH };
  for (const argv of [['--input', 'jobs.ndjson', '--limit', 'abc'], ['--input', 'jobs.ndjson', '--limt=5'], ['--limit', '5']]) {
    const result = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', env, timeout: 20_000 });
    assert.equal(result.status, 1, `${argv.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /usage: node scripts\/regenerate-ai-reports\.mjs/);
  }
});

test('import-windbg-history accepts --before in both forms (issue #375)', () => {
  const script = fileURLToPath(new URL('../scripts/import-windbg-history.mjs', import.meta.url));
  for (const argv of [['--before', 'not-a-date', 'x.jsonl'], ['--bogus=1', 'x.jsonl'], ['--before=2026-09-26T03:39:00Z']]) {
    const result = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 1, argv.join(' '));
    assert.match(result.stderr, /usage: node scripts\/import-windbg-history\.mjs/);
  }
});

test('import-windbg-history runs with the space-separated --before form (issue #375)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwh-'));
  try {
    const file = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    const script = fileURLToPath(new URL('../scripts/import-windbg-history.mjs', import.meta.url));
    const eq = spawnSync(process.execPath, [script, '--before=2026-09-26T03:39:00Z', file], { encoding: 'utf8', timeout: 20_000 });
    const sp = spawnSync(process.execPath, [script, '--before', '2026-09-26T03:39:00Z', file], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(eq.status, 0, eq.stderr);
    assert.equal(sp.status, 0, sp.stderr);
    const strip = (out) => out.replace(/"captured_at":"[^"]*"/g, '');
    assert.equal(strip(sp.stdout), strip(eq.stdout));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
