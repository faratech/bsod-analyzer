import test from 'node:test';
import assert from 'node:assert/strict';

import { createCspReportCollector, parseCspReports, registerCspReportRoute } from '../server/cspReport.js';
import { createFastifyCompatApp } from '../server/fastifyCompat.js';

const LEGACY_REPORT = {
  'csp-report': {
    'document-uri': 'https://bsod.windowsforum.com/analyzer?theme=dark#x',
    'violated-directive': 'script-src-elem',
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'inline',
    'source-file': 'https://bsod.windowsforum.com/analyzer?token=secret',
    'line-number': 12,
    'column-number': 7,
    'script-sample': '(function(){window.__CF$cv$params={r:',
    disposition: 'report',
    'original-policy': "default-src 'self'; …",
  },
};

const REPORTING_API_BATCH = [
  {
    type: 'csp-violation',
    url: 'https://bsod.windowsforum.com/',
    body: {
      documentURL: 'https://bsod.windowsforum.com/',
      blockedURL: 'https://cdnjs.cloudflare.com/ajax/libs/angular.js/1.8.3/angular.min.js?x=1',
      effectiveDirective: 'script-src-elem',
      disposition: 'enforce',
      lineNumber: 1,
      sample: '',
    },
  },
  { type: 'deprecation', body: { id: 'x' } },
];

function fakeLog() {
  const lines = [];
  return {
    lines,
    info: (event, fields) => lines.push({ severity: 'INFO', event, ...fields }),
    warn: (event, fields) => lines.push({ severity: 'WARNING', event, ...fields }),
  };
}

test('both wire formats normalize to the same fields; queries and fragments are dropped', () => {
  const [legacy] = parseCspReports(JSON.stringify(LEGACY_REPORT));
  assert.deepEqual(legacy, {
    document: 'https://bsod.windowsforum.com/analyzer',
    blocked: 'inline',
    directive: 'script-src-elem',
    source: 'https://bsod.windowsforum.com/analyzer',
    line: 12,
    column: 7,
    sample: '(function(){window.__CF$cv$params={r:',
    disposition: 'report',
  });

  const batch = parseCspReports(JSON.stringify(REPORTING_API_BATCH));
  assert.equal(batch.length, 1, 'non-CSP reports in a batch are ignored');
  assert.equal(batch[0].blocked, 'https://cdnjs.cloudflare.com/ajax/libs/angular.js/1.8.3/angular.min.js');
  assert.equal(batch[0].disposition, 'enforce');
});

test('junk bodies yield no reports', () => {
  for (const body of ['', 'not json', '{}', '[1,2]', '{"csp-report": "x"}', JSON.stringify({ type: 'csp-violation' })]) {
    assert.deepEqual(parseCspReports(body), [], body);
  }
});

test('a repeated violation is logged once per window, then with the suppressed count', () => {
  let clock = 0;
  const log = fakeLog();
  const collector = createCspReportCollector({ log, now: () => clock, windowMs: 1000 });
  const body = JSON.stringify(LEGACY_REPORT);
  assert.equal(collector.handle(body), 1);
  assert.equal(collector.handle(body), 0);
  assert.equal(collector.handle(body), 0);
  clock = 1001;
  assert.equal(collector.handle(body), 1);
  assert.equal(log.lines.length, 2);
  assert.equal(log.lines[0].event, 'csp.violation');
  assert.equal(log.lines[0].severity, 'INFO', 'report-only violations are data, not alerts');
  assert.equal(log.lines[1].suppressedSinceLast, 2);

  collector.handle(JSON.stringify(REPORTING_API_BATCH));
  assert.equal(log.lines.at(-1).severity, 'WARNING', 'an enforced violation blocked something for a visitor');
});

test('POST /api/csp-report accepts both report content types and answers 204', async () => {
  const log = fakeLog();
  const app = createFastifyCompatApp({ bodyLimit: 10 * 1024 * 1024 });
  registerCspReportRoute(app, { collector: createCspReportCollector({ log }) });
  app.use((_req, res) => res.status(404).send('not found'));
  await new Promise(resolve => app.listen(0, resolve));
  const base = `http://127.0.0.1:${app.fastify.server.address().port}/api/csp-report`;
  const post = (type, body) => fetch(base, { method: 'POST', headers: { 'content-type': type, connection: 'close' }, body });
  try {
    assert.equal((await post('application/csp-report', JSON.stringify(LEGACY_REPORT))).status, 204);
    assert.equal((await post('application/reports+json', JSON.stringify(REPORTING_API_BATCH))).status, 204);
    assert.equal((await post('application/csp-report', 'garbage')).status, 204);
    assert.deepEqual(log.lines.map(l => l.blocked), ['inline', 'https://cdnjs.cloudflare.com/ajax/libs/angular.js/1.8.3/angular.min.js']);
    // Its own small body limit, not the server's upload limit.
    assert.equal((await post('application/csp-report', 'x'.repeat(65 * 1024))).status, 413);
  } finally {
    await app.fastify.close();
  }
});
