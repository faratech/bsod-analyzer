function formatWindowsVersion(versionNumber) {
  const normalized = String(versionNumber || '').trim();
  const parts = normalized.split('.').map(part => parseInt(part, 10));
  if (parts.length < 2 || parts.some(part => !Number.isFinite(part))) {
    return null;
  }

  const [major, minor] = parts;
  const knownWindowsFamily =
    (major === 10 && minor === 0) ||
    (major === 6 && minor >= 0 && minor <= 3) ||
    (major === 5 && minor >= 0 && minor <= 2);

  if (!knownWindowsFamily) {
    return null;
  }

  return normalized;
}

function extractWinDbgWindowsVersion(output) {
  const text = String(output || '');
  const osVersionMatch = text.match(/\bOS_VERSION:\s*([0-9]+(?:\.[0-9]+){1,3})\b/i);
  if (osVersionMatch) {
    return formatWindowsVersion(osVersionMatch[1]);
  }

  const kernelBannerMatch = text.match(/(^|\n)\s*(Windows\s+(?:[0-9]+\s+)?(?:NT\s+)?(?:Kernel\s+)?Version\s+(?:[0-9]+(?:\.[0-9]+){1,3}|[0-9]{5})[^\n]*)/i);
  if (kernelBannerMatch) {
    return kernelBannerMatch[2].trim();
  }

  return null;
}

export {
  extractWinDbgWindowsVersion,
  formatWindowsVersion
};
