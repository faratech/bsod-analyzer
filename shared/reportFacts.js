// Linked from forum summaries so readers can analyze their own dumps.
const ANALYZER_URL = 'https://bsod.windowsforum.com';

function clean(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\r|\n/g, ' ').replace(/`/g, "'").trim();
  return text || undefined;
}

function compactWindowsBuild(version) {
  const text = clean(version);
  if (!text) return undefined;
  const match = /^10\.0\.(\d{5}\.\d+)$/i.exec(text);
  return match ? match[1] : text;
}

function compactKernelBuild(version) {
  const text = clean(version);
  if (!text) return undefined;
  const fullMatch = /^10\.0\.(\d{5}\.\d+)$/i.exec(text);
  if (fullMatch) return fullMatch[1];
  return /^\d{5}\.\d+$/.test(text) ? text : undefined;
}

function formatBugcheck(report) {
  const code = clean(report?.bugCheck?.code || report?.bugCheckCode);
  const name = clean(report?.bugCheck?.name);
  if (code && name) return `${code} ${name}`;
  return code || name;
}

function analysisMethodLabel(dumpFile) {
  if (dumpFile?.analysisMethod === 'windbg') return dumpFile.cached ? 'WinDbg, cached' : 'WinDbg';
  if (dumpFile?.analysisMethod === 'local') return 'Limited fallback';
  return dumpFile?.cached ? 'Cached analysis' : 'Analysis';
}

function evidenceSource(dumpFile) {
  if (dumpFile?.analysisMethod === 'windbg') return 'windbg';
  if (dumpFile?.analysisMethod === 'local') return 'fallback';
  return 'mixed';
}

function confidenceLabel(source) {
  if (source === 'windbg') return 'WinDbg confirmed';
  if (source === 'fallback') return 'Limited fallback';
  return 'AI interpreted';
}

// A dump a person forced (power button held, keyboard hotkey, debugger) records
// that action, not the hang or crash that came first. Live-dump forms are not
// here: the system kept running. Sources: Microsoft Learn, Bug Check 0x1C8 and
// 0xE2, "Forcing a System Crash".
function forcedCrashNote(report) {
  const raw = `${report?.bugCheck?.code ?? report?.bugCheckCode ?? ''} ${report?.bugCheck?.name ?? ''}`;
  const code = /0x0*([0-9a-f]+)/i.exec(raw)?.[1]?.toUpperCase();
  if (code === '1C8' || /MANUALLY_INITIATED_POWER_BUTTON_HOLD(?!_LIVE)/i.test(raw)) {
    return 'This crash was forced by holding the power button. A dump taken this way records that action, not the hang or crash that came first, so the original cause is not in this report.';
  }
  if (code === 'E2' || code === 'DEADDEAD' || /MANUALLY_INITIATED_CRASH/i.test(raw)) {
    return 'This crash was forced from the keyboard or a debugger. A dump taken this way records that action, not a fault, so whatever prompted it is not in this report.';
  }
  return undefined;
}

function caveatFor(source) {
  if (source === 'windbg') {
    return 'Core crash facts are taken from WinDbg output; the explanation and recommendations are AI-assisted.';
  }
  if (source === 'fallback') {
    return 'WinDbg was unavailable, so this is a limited analysis from local or sampled dump evidence.';
  }
  return 'Some fields are AI-interpreted from available crash evidence.';
}

function uniqueFacts(facts) {
  const seen = new Set();
  return facts.filter(fact => {
    const key = `${fact.label}\0${fact.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getReportFacts(dumpFile) {
  const report = dumpFile?.report;
  if (!report) return null;

  const source = evidenceSource(dumpFile);
  const kernelBuild = clean(report.systemInfo?.kernelBuild)
    || compactKernelBuild(report.systemInfo?.kernelImageVersion)
    || compactKernelBuild(report.imageVersion)
    || clean(report.systemInfo?.windowsVersion);
  const imageVersion = clean(report.imageBuild)
    || compactWindowsBuild(report.imageVersion)
    || clean(report.imageVersion);
  const bugcheck = formatBugcheck(report);
  const culprit = clean(report.culprit)
    || clean(report.moduleName)
    || clean(report.imageName)
    || 'Unknown';
  const primaryCause = clean(report.probableCause)
    || clean(report.summary)
    || 'The probable cause could not be determined from the available data.';
  const topActions = (report.recommendations || [])
    .map(clean)
    .filter(Boolean)
    .slice(0, 5);

  const facts = uniqueFacts([
    bugcheck ? { label: 'Bugcheck', value: bugcheck, mono: true } : undefined,
    kernelBuild ? { label: 'Build', value: kernelBuild, mono: true } : undefined,
    report.systemInfo?.windowsVersion ? { label: 'Windows', value: clean(report.systemInfo.windowsVersion) } : undefined,
    report.imageName ? { label: 'Image', value: clean(report.imageName), mono: true } : undefined,
    imageVersion && imageVersion !== kernelBuild ? { label: 'Image version', value: imageVersion, mono: true } : undefined,
    report.moduleName ? { label: 'Module', value: clean(report.moduleName), mono: true } : undefined,
    report.systemInfo?.processName ? { label: 'Process', value: clean(report.systemInfo.processName), mono: true } : undefined,
    report.symbolName ? { label: 'Symbol', value: clean(report.symbolName), mono: true } : undefined,
    report.failureBucketId ? { label: 'Bucket', value: clean(report.failureBucketId), mono: true } : undefined,
    report.systemInfo?.systemUptime ? { label: 'Uptime', value: clean(report.systemInfo.systemUptime) } : undefined,
  ].filter(fact => fact && fact.value));

  return {
    title: clean(report.summary) || 'Crash analysis completed.',
    confidenceLabel: confidenceLabel(source),
    evidenceSource: source,
    analysisMethodLabel: analysisMethodLabel(dumpFile),
    primaryCause,
    culprit,
    bugcheck,
    kernelBuild,
    windowsVersion: clean(report.systemInfo?.windowsVersion),
    processName: clean(report.systemInfo?.processName),
    imageName: clean(report.imageName),
    imageVersion,
    moduleName: clean(report.moduleName),
    symbolName: clean(report.symbolName),
    failureBucketId: clean(report.failureBucketId),
    systemUptime: clean(report.systemInfo?.systemUptime),
    facts,
    topActions,
    caveat: caveatFor(source),
    forcedCrash: forcedCrashNote(report),
  };
}

// Path redaction for the forum-safe summary (issue #151). A path is redacted as
// a whole span: directory segments may contain spaces ("Jane Doe", "Program
// Files (x86)") because the next separator closes them, while the last segment
// stops at whitespace so the sentence after a path survives. Separator runs
// cover JSON-escaped paths (C:\\Users\\...). Segment characters exclude ':'
// and the markdown/quote delimiters, so a scan never runs past the next
// drive prefix or delimiter and stays linear.
const PATH_SEGMENT = String.raw`[^\\/\r\n"'\x60|<>*?:]+`;
const PATH_LAST_SEGMENT = String.raw`[^\\/\s"'\x60|<>*?:)]*`;
const PATH_TAIL = String.raw`(?:${PATH_SEGMENT}[\\/]+)*${PATH_LAST_SEGMENT}`;
// C:\..., C:/..., and the \??\C:\ / \\?\C:\ / \\.\C:\ prefixed forms.
const DRIVE_PATH_RE = new RegExp(String.raw`(?:\\\\[?.]\\|\\\?\?\\)?\b[A-Z]:[\\/]+${PATH_TAIL}`, 'gi');
// NT device paths: \Device\HarddiskVolume3\Users\<name>\...
const DEVICE_PATH_RE = new RegExp(String.raw`\\Device[\\/]+${PATH_TAIL}`, 'gi');
// UNC paths: \\server\share\...
const UNC_PATH_RE = new RegExp(String.raw`\\\\(?=[^\\/\s])${PATH_TAIL}`, 'g');
// A profile name in any remaining form (%SystemDrive%\Users\<name>, Users/<name>).
// It may contain spaces and runs to the next separator or delimiter, so a
// trailing "Users\Jane Doe" is masked whole.
const PROFILE_NAME_RE = new RegExp(String.raw`\b(Users|Documents and Settings)([\\/]+)[^\\/\r\n"'\x60|<>*?:)]+`, 'gi');

export function redactPublicReportText(value) {
  return String(value || '')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip-redacted]')
    .replace(/\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]{1,}\b/gi, '[ip-redacted]')
    .replace(PROFILE_NAME_RE, '$1$2[user-redacted]')
    .replace(DRIVE_PATH_RE, '[path-redacted]')
    .replace(DEVICE_PATH_RE, '[path-redacted]')
    .replace(UNC_PATH_RE, '[path-redacted]')
    .replace(/\bWF-[0-9a-f-]{36}(?:-\d+)?\b/gi, '[job-redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id-redacted]');
}

// These reports are pasted into markdown-rendering surfaces (forums, issue
// trackers), and their text ultimately derives from attacker-supplied dump
// content. Neutralize link syntax so a crafted dump cannot plant clickable
// links at the destination (issue #81) — the URL stays visible as plain text.
export function neutralizeMarkdownLinks(value) {
  return String(value || '').replace(
    /\[([^\]\n]{0,200})\]\((https?:\/\/[^\s)]+)\)/g,
    '$1 ($2)'
  );
}

// The forum summary is pasted into XenForo, which renders BBCode. Rewrite the
// tags that create links, images, embeds or mailto links into plain text
// (issue #259): `[URL=x]text[/URL]` becomes `text (x)`, `[IMG]x[/IMG]` becomes
// `x`. Tag names match case-insensitively; complete pairs unwrap innermost
// first, unmatched tags are dropped only once no pair is left, and the loop
// re-runs until nothing changes, so nested or split tags (`[UR[/URL]L=x]`)
// cannot reassemble. Every change removes at least one `]`, so it terminates.
// Both the `[TAG=option]` form and the attribute form (`[URL unfurl="true"]`,
// `[IMG alt="a" width="1"]`, `[URL='x' unfurl="true"]`) are matched: the tag
// name must be followed by `=`, whitespace or `]` (issue #281).
// The tag tail is bounded (BBCODE_TAIL_MAX) so a long unterminated tail costs
// a bounded scan per `[` instead of one to the end of the line (issue #310).
// An opener whose tail is longer than that is defanged (`[` becomes `(`), so a
// long tail cannot slip a working tag past the bounded patterns.
const BBCODE_TAIL_MAX = 512;
const BBCODE_PAIRED_RE = new RegExp(String.raw`\[(URL|IMG|MEDIA|EMAIL)(?=[=\s\]])([^\]\n]{0,${BBCODE_TAIL_MAX}})\]([^[\n]*?)\[\/\1\s*\]`, 'gi');
const BBCODE_STRAY_RE = new RegExp(String.raw`\[\/?(?:URL|IMG|MEDIA|EMAIL)(?=[=\s\]])([^\]\n]{0,${BBCODE_TAIL_MAX}})\]`, 'gi');
const BBCODE_OVERLONG_RE = new RegExp(String.raw`\[(?=\/?(?:URL|IMG|MEDIA|EMAIL)[=\s][^\]\n]{${BBCODE_TAIL_MAX}})`, 'gi');

// The option of a tag tail: the value after a leading `=` (quoted, or up to
// the first ` name=` attribute); attribute-only tails carry no option. One
// forward search finds the attribute: `\s[\w-]+\s*=` cannot backtrack across
// a whitespace run the way a lazy match with a `(?=\s+...)` lookahead did.
function bbcodeOption(tail) {
  const text = String(tail || '');
  const lead = /^\s*=\s*/.exec(text);
  if (!lead) return '';
  const rest = text.slice(lead[0].length);
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1);
    if (end !== -1) return rest.slice(1, end).trim();
  }
  const attribute = /\s[\w-]+\s*=/.exec(rest);
  return (attribute ? rest.slice(0, attribute.index) : rest).trim();
}

export function neutralizeBBCodeLinks(value) {
  let out = String(value || '');
  for (;;) {
    const paired = out.replace(BBCODE_PAIRED_RE, (_match, _tag, option, inner) => {
      const target = bbcodeOption(option);
      const text = inner.trim();
      if (!target || target === text) return text;
      return text ? `${text} (${target})` : target;
    });
    if (paired !== out) { out = paired; continue; }
    // No complete pairs left: drop unmatched tags (keeping any target).
    const stray = out.replace(BBCODE_STRAY_RE, (_match, option) => {
      const target = bbcodeOption(option);
      return target ? `(${target}) ` : '';
    });
    if (stray !== out) { out = stray; continue; }
    // Last, openers too long for the bounded patterns. Each pass removes a
    // `[` or a `]`, so the loop still terminates.
    const defanged = out.replace(BBCODE_OVERLONG_RE, '(');
    if (defanged === out) return out;
    out = defanged;
  }
}

export function generateForumReport(dumpFile) {
  const facts = getReportFacts(dumpFile);
  if (!facts) return '';

  const lines = [
    '## BSOD Analysis Summary',
    '',
    `**Result:** ${facts.title}`,
    `**Confidence:** ${facts.confidenceLabel}`,
  ];

  if (facts.bugcheck) lines.push(`**Bugcheck:** \`${facts.bugcheck}\``);
  if (facts.kernelBuild) lines.push(`**Windows build:** \`${facts.kernelBuild}\``);
  if (facts.culprit) lines.push(`**Likely culprit:** \`${facts.culprit}\``);
  if (facts.imageName) lines.push(`**Image:** \`${facts.imageName}\``);
  if (facts.symbolName) lines.push(`**Symbol:** \`${facts.symbolName}\``);
  if (facts.failureBucketId) lines.push(`**Failure bucket:** \`${facts.failureBucketId}\``);
  if (facts.forcedCrash) lines.push(`**Note:** ${facts.forcedCrash}`);

  lines.push('', '### Recommended next steps');
  const actions = facts.topActions.length > 0
    ? facts.topActions
    : ['Review the WinDbg evidence and update the driver or Windows component identified above.'];
  actions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));

  lines.push('', `_${facts.caveat} Private upload details and raw dump output omitted._`);
  lines.push('', `Analyzed with BSOD Analyzer: ${ANALYZER_URL}`);
  return neutralizeMarkdownLinks(neutralizeBBCodeLinks(redactPublicReportText(lines.join('\n'))));
}

export function generateMarkdownReport(dumpFile) {
  const report = dumpFile?.report;
  const facts = getReportFacts(dumpFile);
  if (!report || !facts) return '';

  const displayName = dumpFile.displayName || dumpFile.file?.name || 'crash dump';
  const lines = [
    `# BSOD Analysis Report for ${displayName}`,
    '',
    `> ${facts.title}`,
    '',
    `**Confidence:** ${facts.confidenceLabel}`,
    `**Analysis method:** ${facts.analysisMethodLabel}`,
    '',
  ];

  if (facts.facts.length > 0) {
    lines.push('## Crash Snapshot', '');
    for (const fact of facts.facts) {
      const value = fact.mono ? `\`${fact.value}\`` : fact.value;
      lines.push(`- **${fact.label}:** ${value}`);
    }
    lines.push('');
  }

  lines.push('## Probable Cause', '', facts.primaryCause, '');
  if (facts.topActions.length > 0) {
    lines.push('## Recommended Actions', '');
    facts.topActions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));
    lines.push('');
  }

  if (report.parameterAnalysis?.length) {
    lines.push('## Parameter Analysis', '', '| Parameter | Value | Decoded | Significance |', '|-----------|-------|---------|--------------|');
    report.parameterAnalysis.forEach(param => {
      lines.push(`| ${param.parameter} | \`${param.rawValue}\` | ${param.decoded} | ${param.significance} |`);
    });
    lines.push('');
  }

  if (report.hardwareError?.isHardwareError) {
    lines.push('## Hardware Error', '');
    lines.push(`- **Severity:** ${report.hardwareError.severity}`);
    lines.push(`- **Type:** ${report.hardwareError.errorType}`);
    lines.push(`- **Component:** ${report.hardwareError.component}`);
    report.hardwareError.details?.forEach(detail => lines.push(`- ${detail}`));
    lines.push('');
  }

  if (report.driverWarnings?.length) {
    lines.push('## Driver Warnings', '');
    report.driverWarnings.forEach(warning => {
      lines.push(`### ${warning.driverName}${warning.isAssociatedWithBugCheck ? ' (related)' : ''}`);
      lines.push(`- **Display name:** ${warning.displayName}`);
      lines.push(`- **Manufacturer:** ${warning.manufacturer}`);
      lines.push(`- **Category:** ${warning.category}`);
      warning.issues?.forEach(issue => lines.push(`- ${issue}`));
      warning.recommendations?.forEach(rec => lines.push(`- Recommendation: ${rec}`));
      lines.push('');
    });
  }

  if (report.callStack?.length) {
    lines.push('## Call Stack', '', '```text');
    report.callStack.forEach((frame, index) => {
      const symbol = frame.function ? `${frame.module}!${frame.function}${frame.offset ? `+${frame.offset}` : ''}` : frame.module;
      lines.push(`${String(index).padStart(2, '0')} ${frame.address} ${symbol}`);
    });
    lines.push('```', '');
  }

  if (report.rawWinDbgOutput) {
    lines.push('## Raw WinDbg Output', '', '<details>', `<summary>${report.rawWinDbgOutput.length.toLocaleString()} characters</summary>`, '', '```text', report.rawWinDbgOutput, '```', '', '</details>', '');
  }

  if (facts.forcedCrash) lines.push(`> ${facts.forcedCrash}`, '');
  lines.push(`_${facts.caveat}_`);
  return neutralizeMarkdownLinks(lines.join('\n'));
}
