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
  };
}

export function redactPublicReportText(value) {
  return String(value || '')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip-redacted]')
    .replace(/\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]{1,}\b/gi, '[ip-redacted]')
    .replace(/\b[A-Z]:\\[^\s`|)]+/gi, '[path-redacted]')
    .replace(/\\\\[^\s`|)]+/g, '[path-redacted]')
    .replace(/\bWF-[0-9a-f-]{36}(?:-\d+)?\b/gi, '[job-redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id-redacted]');
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

  lines.push('', '### Recommended next steps');
  const actions = facts.topActions.length > 0
    ? facts.topActions
    : ['Review the WinDbg evidence and update the driver or Windows component identified above.'];
  actions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));

  lines.push('', `_${facts.caveat} Private upload details and raw dump output omitted._`);
  return redactPublicReportText(lines.join('\n'));
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

  lines.push(`_${facts.caveat}_`);
  return lines.join('\n');
}
