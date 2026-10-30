import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// What the site's pages tell visitors must match what the service does
// (CLAUDE.md: keep /privacy factual). The pages' visible text is read from the
// JSX source with tags dropped and whitespace collapsed.
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const pageText = file => read(file)
  .replace(/<[^>]+>/g, ' ')
  .replace(/\{' '\}/g, ' ')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

test('/privacy says the WinDBG fallback sends dump strings and byte excerpts to the AI provider (issues #345, #365)', async () => {
  const text = pageText('pages/Privacy.tsx');
  assert.doesNotMatch(text, /The dump file itself is not sent to them/);
  assert.match(text, /If the WinDBG analysis is unavailable[^.]*text strings and short byte excerpts read from the dump/);
  // The removal covers the hex-dumped byte excerpts too (issues #359, #360),
  // and says exactly which names are found and what is not covered (#365).
  assert.match(text, /Before sending, your browser removes, from the byte excerpts as well as the text: the user folder name in Windows paths \(the folder after C:\\Users\), the user and computer names in environment strings such as USERNAME and COMPUTERNAME, email addresses, and other whole-word occurrences of up to 128 of the names found this way \(names of three or more characters, or two in scripts such as Chinese, Japanese or Korean\)\./);
  assert.match(text, /Names are recognized only by where they appear: a name, or part of one, that the dump shows only outside such a path, environment string or email address is not removed\./);
  assert.doesNotMatch(text, /user folder names, the user and computer names in environment strings, and email addresses removed first/);
  assert.match(text, /stored with the report/);
  const { MAX_HUNTED_NAMES } = await import('../shared/promptRedaction.js');
  assert.equal(MAX_HUNTED_NAMES, 128, 'the page states the hunted-name cap');
});

test('/privacy names Google Analytics, what it receives and when it loads (issue #346)', () => {
  const html = read('index.html');
  assert.match(html, /window\.__ANALYTICS_ENABLED__ = true;/, 'analytics is on in the shipped page');
  assert.match(html, /googletagmanager\.com\/gtag\/js/);
  const text = pageText('pages/Privacy.tsx');
  assert.match(text, /Google Analytics/);
  for (const event of [/pages you view/, /dump type and size/, /analysis starts and finishes/, /donation/i]) {
    assert.match(text, event);
  }
  assert.match(text, /never the file, its name or its contents/);
  assert.match(text, /cookies/);
  assert.match(text, /first interaction with a page, or after about a minute/);
});

test('About and Documentation do not claim Gemini-only AI, cached instant results or no file storage (issue #351)', () => {
  // The analysis cache is off and the primary model is not Gemini.
  assert.match(read('redis.cfg'), /^disabled$/m);
  assert.doesNotMatch(read('model.cfg').replace(/^#.*$/gm, ''), /gemini/i);
  const files = ['pages/About.tsx', 'pages/Documentation.tsx', 'pages/Home.tsx', 'pages/Analyzer.tsx', 'index.html', 'README.md'];
  for (const file of files) {
    const text = pageText(file);
    assert.doesNotMatch(text, /Gemini AI/i, `${file}: names Gemini as the AI`);
    assert.doesNotMatch(text, /instant(ly)? (results|from cache)|for cached files|Results are cached/i, `${file}: cached results`);
    assert.doesNotMatch(text, /no permanent file storage/i, `${file}: storage claim`);
  }
  const about = pageText('pages/About.tsx');
  assert.match(about, /kept to improve BSOD AI/);
});

test('the About animation and Documentation state the real upload limit (issue #352)', async () => {
  const { FILE_LIMITS } = await import('../shared/ingestPolicy.js');
  assert.equal(FILE_LIMITS.maxFileSize, 100 * 1024 * 1024);
  const flow = read('components/flow/BsodFlowPiece.tsx');
  assert.match(flow, /import \{[^}]*FILE_LIMITS[^}]*\} from '\.\.\/\.\.\/shared\/ingestPolicy\.js'/);
  assert.match(flow, /up to \$\{formatBytes\(FILE_LIMITS\.maxFileSize\)\}/);
  assert.doesNotMatch(flow, /\b500 MB\b|\b\d+(\.\d+)? GB\b/, 'no upload example above the limit');
  const docs = pageText('pages/Documentation.tsx');
  assert.match(docs, /formatBytes\(FILE_LIMITS\.maxFileSize\)/);
  assert.match(docs, /MEMORY\.DMP is usually larger/);
  assert.match(docs, /C:\\Windows\\Minidump\\/);
});
