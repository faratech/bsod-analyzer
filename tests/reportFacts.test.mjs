import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateForumReport,
  generateMarkdownReport,
  getReportFacts,
  neutralizeBBCodeLinks,
  redactPublicReportText
} from '../shared/reportFacts.js';
import { assertScalesLinearly } from './helpers/linearTime.mjs';

function dumpFile(report, overrides = {}) {
  return {
    id: 'dump-1',
    displayName: 'MEMORY.DMP',
    file: { name: 'MEMORY.DMP', size: 4096 },
    status: 'analyzed',
    analysisMethod: 'windbg',
    report,
    ...overrides
  };
}

test('report facts prefer precise kernel build evidence', () => {
  const facts = getReportFacts(dumpFile({
    summary: 'Crash in the Windows kernel scheduler.',
    probableCause: 'WinDbg identified nt!KiExecuteAllDpcs.',
    culprit: 'nt',
    recommendations: ['Install the latest cumulative update.'],
    imageName: 'ntkrnlmp.exe',
    imageVersion: '10.0.26200.8655',
    systemInfo: {
      windowsVersion: 'Windows 10 Kernel Version 26200 MP (16 procs) Free x64'
    }
  }));

  assert.equal(facts.kernelBuild, '26200.8655');
  assert.ok(facts.facts.some(fact => fact.label === 'Build' && fact.value === '26200.8655'));
  assert.ok(facts.facts.some(fact => fact.label === 'Image' && fact.value === 'ntkrnlmp.exe'));
});

test('report facts do not treat third-party image versions as Windows builds', () => {
  const facts = getReportFacts(dumpFile({
    summary: 'Crash in a display driver.',
    probableCause: 'WinDbg identified nvlddmkm.',
    culprit: 'nvlddmkm.sys',
    recommendations: ['Update the NVIDIA display driver.'],
    imageName: 'nvlddmkm.sys',
    imageVersion: '32.0.15.7628',
    systemInfo: {
      windowsVersion: 'Windows 10 Kernel Version 26100'
    }
  }));

  assert.equal(facts.kernelBuild, 'Windows 10 Kernel Version 26100');
  assert.ok(facts.facts.some(fact => fact.label === 'Image version' && fact.value === '32.0.15.7628'));
});

test('forum report is concise and privacy-safe', () => {
  const report = generateForumReport(dumpFile({
    summary: 'Dump came from C:\\Users\\Alice\\Desktop and source 203.0.113.42.',
    probableCause: 'Failure bucket WF-12345678-1234-1234-1234-123456789abc-42 points to nt.',
    culprit: 'nt',
    recommendations: ['Review C:\\Temp\\MEMORY.DMP before sharing.'],
    bugCheck: { code: '0xA', name: 'IRQL_NOT_LESS_OR_EQUAL', parameters: [] },
    failureBucketId: 'WF-12345678-1234-1234-1234-123456789abc-42',
    rawWinDbgOutput: 'PRIVATE_RAW_OUTPUT 203.0.113.42 C:\\Users\\Alice\\dump.dmp',
    systemInfo: {
      kernelImageVersion: '10.0.26200.8655'
    }
  }));

  assert.match(report, /Windows build:\*\* `26200\.8655`/);
  assert.doesNotMatch(report, /203\.0\.113\.42/);
  assert.doesNotMatch(report, /C:\\Users\\Alice/);
  assert.doesNotMatch(report, /WF-12345678-1234-1234-1234-123456789abc-42/);
  assert.doesNotMatch(report, /PRIVATE_RAW_OUTPUT/);
  assert.match(report, /\nAnalyzed with BSOD Analyzer: https:\/\/bsod\.windowsforum\.com$/);
});

test('markdown export keeps technician evidence', () => {
  const report = generateMarkdownReport(dumpFile({
    summary: 'Crash in nt.',
    probableCause: 'WinDbg identified nt.',
    culprit: 'nt',
    recommendations: ['Review the stack.'],
    rawWinDbgOutput: 'RAW_WINDBG_OUTPUT',
    systemInfo: {
      kernelImageVersion: '10.0.26200.8655'
    }
  }));

  assert.match(report, /Build:\*\* `26200\.8655`/);
  assert.match(report, /Raw WinDbg Output/);
  assert.match(report, /RAW_WINDBG_OUTPUT/);
});

test('public redaction removes direct identifiers', () => {
  const text = redactPublicReportText('ip 198.51.100.20 path C:\\Crash\\MEMORY.DMP id 12345678-1234-1234-1234-123456789abc');

  assert.equal(text, 'ip [ip-redacted] path [path-redacted] id [id-redacted]');
});

test('public redaction removes whole paths with spaces, device and forward-slash forms (issue #151)', () => {
  const cases = [
    ['C:\\Users\\Jane Doe\\AppData\\Local\\x.sys was loaded', '[path-redacted] was loaded'],
    ['"C:\\Program Files\\Acme Corp\\agent.sys"', '"[path-redacted]"'],
    ['(see C:\\Program Files (x86)\\Foo\\bar.sys)', '(see [path-redacted])'],
    ['see \\Device\\HarddiskVolume3\\Users\\jdoe\\Downloads\\x.dmp now', 'see [path-redacted] now'],
    ['C:/Users/jdoe/Desktop/x.dmp', '[path-redacted]'],
    ['\\??\\C:\\Users\\jdoe\\x.sys', '[path-redacted]'],
    ['\\\\server\\share\\Jane Doe\\x.txt ok', '[path-redacted] ok'],
    ['escaped C:\\\\Users\\\\jdoe\\\\x.sys end', 'escaped [path-redacted] end'],
    ['profile C:\\Users\\Jane Doe', 'profile [path-redacted]'],
    ['%SystemDrive%\\Users\\jdoe\\file.txt', '%SystemDrive%\\Users\\[user-redacted]\\file.txt'],
    ['**Likely culprit:** `C:\\Users\\jdoe\\x.sys`', '**Likely culprit:** `[path-redacted]`'],
    // The sentence after a path survives, and URLs and \SystemRoot paths are untouched.
    ['Update C:\\Windows\\System32\\drivers\\nvlddmkm.sys to the latest version.', 'Update [path-redacted] to the latest version.'],
    ['Analyzed with BSOD Analyzer: https://bsod.windowsforum.com/', 'Analyzed with BSOD Analyzer: https://bsod.windowsforum.com/'],
    ['Image path: \\SystemRoot\\system32\\drivers\\nvlddmkm.sys', 'Image path: \\SystemRoot\\system32\\drivers\\nvlddmkm.sys'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactPublicReportText(input), expected, input);
  }
});

test('the forum report never carries a profile name from the AI text', () => {
  const report = generateForumReport(dumpFile({
    summary: 'The dump at C:\\Users\\Jane Doe\\Desktop\\crash.dmp shows a driver fault.',
    probableCause: 'nt',
    culprit: 'C:\\Users\\Jane Doe\\AppData\\Local\\Acme\\agent.sys',
    recommendations: ['Remove \\Device\\HarddiskVolume3\\Users\\jdoe\\Tools\\hook.sys and reboot.']
  }));
  assert.doesNotMatch(report, /Jane|Doe|jdoe/);
  assert.match(report, /shows a driver fault/);
  assert.match(report, /and reboot\./);
});

test('markdown links in AI-derived report text are neutralized (issue #81)', () => {
  const markdown = generateMarkdownReport(dumpFile({
    summary: 'Crash in nt. See [our forum](https://evil.example/spam) for details.',
    probableCause: 'WinDbg identified nt.',
    culprit: 'nt',
    recommendations: ['Check [the guide](https://evil.example/guide).'],
    systemInfo: { kernelImageVersion: '10.0.26200.8655' }
  }));

  assert.ok(!/\[([^\]]+)\]\(https?:\/\//.test(markdown), 'markdown link syntax must not survive');
  assert.match(markdown, /our forum \(https:\/\/evil\.example\/spam\)/);
});

test('the forum report also neutralizes links after redaction', () => {
  const report = generateForumReport(dumpFile({
    summary: 'Crash.',
    probableCause: 'nt',
    recommendations: ['Read [this](https://evil.example/x).']
  }));

  assert.ok(!/\]\(https?:\/\//.test(report));
  assert.match(report, /this \(https:\/\/evil\.example\/x\)/);
});

test('the forum report neutralizes BBCode link and media tags (issue #259)', () => {
  const report = generateForumReport(dumpFile({
    summary: 'Crash.',
    probableCause: 'nt',
    recommendations: [
      '[URL=https://evil.example/fix.exe]Download the official fixed driver[/URL]',
      '[IMG]https://evil.example/t.png[/IMG]',
      '[url="https://evil.example/q"]quoted[/Url] and [URL]https://evil.example/bare[/URL]',
      '[MEDIA=youtube]dQw4w9WgXcQ[/MEDIA] or [email=a@evil.example]mail me[/EMAIL] [Email]b@evil.example[/email]',
      '[[URL]combo[/URL]](https://evil.example/m) Nested [URL=https://evil.example/n][IMG]https://evil.example/n.png[/IMG][/URL] and [UR[/URL]L=https://evil.example/s]split[/URL]'
    ]
  }));

  assert.doesNotMatch(report, /\[\/?(?:url|img|media|email)\b/i, report);
  assert.match(report, /Download the official fixed driver \(https:\/\/evil\.example\/fix\.exe\)/);
  assert.match(report, /^2\. https:\/\/evil\.example\/t\.png$/m);
  assert.match(report, /quoted \(https:\/\/evil\.example\/q\) and https:\/\/evil\.example\/bare/);
  assert.match(report, /dQw4w9WgXcQ \(youtube\) or mail me \(a@evil\.example\) b@evil\.example/);
  // Unwrapping BBCode must not assemble a Markdown link either.
  assert.ok(!/\]\(https?:\/\//.test(report), report);
  assert.match(report, /combo \(https:\/\/evil\.example\/m\) Nested/);
  assert.match(report, /Nested https:\/\/evil\.example\/n\.png \(https:\/\/evil\.example\/n\)/);
  // A split tag cannot reassemble; its target survives only as plain text.
  assert.match(report, /\(https:\/\/evil\.example\/s\) split/);
});

test('the BBCode neutralizer stays linear on long or unterminated tag tails (issue #310)', () => {
  // Each builder gives the full-size input (at least 100 KB) at scale 8 and
  // an eighth of it at scale 1; the check compares the two timings instead of
  // a wall-clock budget, so a busy machine cannot fail it.
  const inputs = {
    'option of spaces then letters, paired': k => '[URL=x' + ' '.repeat(6_250 * k) + 'a'.repeat(6_250 * k) + ']t[/URL]',
    'option of spaces then letters, stray': k => '[URL=x' + ' '.repeat(6_250 * k) + 'a'.repeat(6_250 * k) + ']',
    'many unterminated attribute openers': k => '[URL '.repeat(2_500 * k),
    'many unterminated option openers': k => '[URL='.repeat(2_500 * k),
    'unterminated option': k => '[URL=' + 'a'.repeat(12_500 * k),
    'many short options with whitespace runs': k => ('[URL=x' + ' '.repeat(500) + 'a]t[/URL]').repeat(25 * k),
  };
  for (const [name, input] of Object.entries(inputs)) {
    assert.ok(input(8).length >= 100_000, name);
    assertScalesLinearly(name, neutralizeBBCodeLinks, input);
  }

  const payload = inputs['option of spaces then letters, paired'];
  assertScalesLinearly(
    'Copy for forum',
    text => generateForumReport(dumpFile({ summary: text, probableCause: text, recommendations: [text] })),
    payload
  );
});

test('a BBCode tag with an overlong tail is still neutralized (issue #310)', () => {
  for (const input of [
    '[URL=https://evil.example/' + 'a'.repeat(600) + ']click[/URL]',
    '[URL unfurl="true"' + ' '.repeat(600) + ']https://evil.example/x[/URL]',
    '[URL]a [URL ' + 'b'.repeat(600) + '] c[/URL]',
    '[IMG alt="' + 'x'.repeat(600) + '"]https://evil.example/p.png',
  ]) {
    const out = neutralizeBBCodeLinks(input);
    assert.doesNotMatch(out, /\[\/?(?:url|img|media|email)(?=[=\s\]])/i, out.slice(0, 80));
  }
  // Long options on ordinary tags are parsed as before.
  const spaced = '[URL=https://evil.example/s' + ' '.repeat(300) + 'unfurl="true"]text[/URL]';
  assert.equal(neutralizeBBCodeLinks(spaced), 'text (https://evil.example/s)');
});

test('the BBCode neutralizer also rewrites attribute-form tags (issue #281)', () => {
  const cases = [
    ['[URL unfurl="true"]https://evil.example/x[/URL]', 'https://evil.example/x'],
    ['[IMG alt="a"]https://evil.example/p.png[/IMG]', 'https://evil.example/p.png'],
    ['[IMG width="1px"]https://evil.example/p.png[/IMG]', 'https://evil.example/p.png'],
    ['[img Width="1px" ALT="x y"]https://evil.example/p.png[/Img]', 'https://evil.example/p.png'],
    ["[URL='https://evil.example' unfurl=\"true\"]click[/URL]", 'click (https://evil.example)'],
    ['[url="https://evil.example/q" unfurl="true"]quoted[/url]', 'quoted (https://evil.example/q)'],
    ['[Url=https://evil.example/u unfurl="true"]bare[/uRl]', 'bare (https://evil.example/u)'],
    ['[MEDIA=youtube width="1"]abc[/MEDIA]', 'abc (youtube)'],
    ['[EMAIL subject="hi"]a@evil.example[/EMAIL]', 'a@evil.example'],
    // Nested attribute forms unwrap innermost first.
    ['[URL unfurl="true"][IMG alt="a"]https://evil.example/n.png[/IMG][/URL]', 'https://evil.example/n.png'],
    // Unmatched attribute-form tags are dropped, keeping any target.
    ['[URL unfurl="true"]dangling', 'dangling'],
    ['[IMG alt="a"]x [/URL]', 'x'],
    ['[URL=https://evil.example/o unfurl="true"]open', '(https://evil.example/o) open']
  ];
  for (const [input, expected] of cases) {
    const out = neutralizeBBCodeLinks(input);
    assert.doesNotMatch(out, /\[\/?(?:url|img|media|email)\b/i, `${input} => ${out}`);
    assert.equal(out.trim(), expected, input);
  }

  // A split attribute-form tag cannot reassemble into a working tag.
  const split = neutralizeBBCodeLinks('[UR[/URL]L unfurl="true"]https://evil.example/s[/URL] [IM[IMG alt="a"][/IMG]G alt="b"]x[/IMG]');
  assert.doesNotMatch(split, /\[\/?(?:url|img|media|email)\b/i, split);

  // Names that merely start with a tag name are left alone.
  assert.equal(neutralizeBBCodeLinks('[URLS] [IMAGE alt="a"]'), '[URLS] [IMAGE alt="a"]');

  const report = generateForumReport(dumpFile({
    summary: 'Crash.',
    probableCause: 'nt',
    recommendations: ['[URL unfurl="true"]https://evil.example/x[/URL] then [IMG alt="a"]https://evil.example/p.png[/IMG]']
  }));
  assert.doesNotMatch(report, /\[\/?(?:url|img|media|email)\b/i, report);
  assert.match(report, /https:\/\/evil\.example\/x then https:\/\/evil\.example\/p\.png/);
});
