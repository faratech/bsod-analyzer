function getWindowsVersionName(version) {
  const parts = String(version || '').split('.');
  if (parts.length < 2) return '';

  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  const build = parts.length >= 3 ? parseInt(parts[2], 10) : 0;

  if (major === 10 && minor === 0) {
    if (build >= 26200) return 'Windows 11 25H2';
    if (build >= 26100) return 'Windows 11 24H2';
    if (build >= 22631) return 'Windows 11 23H2';
    if (build >= 22621) return 'Windows 11 22H2';
    if (build >= 22000) return 'Windows 11 21H2';

    if (build >= 19045) return 'Windows 10 22H2';
    if (build >= 19044) return 'Windows 10 21H2';
    if (build >= 19043) return 'Windows 10 21H1';
    if (build >= 19042) return 'Windows 10 20H2';
    if (build >= 19041) return 'Windows 10 2004';
    if (build >= 18363) return 'Windows 10 1909';
    if (build >= 18362) return 'Windows 10 1903';
    if (build >= 17763) return 'Windows 10 1809';
    if (build >= 17134) return 'Windows 10 1803';
    if (build >= 16299) return 'Windows 10 1709';
    if (build >= 15063) return 'Windows 10 1703';
    if (build >= 14393) return 'Windows 10 1607';
    if (build >= 10586) return 'Windows 10 1511';
    if (build >= 10240) return 'Windows 10 1507';
    return 'Windows 10';
  }

  if (major === 6 && minor === 3) return 'Windows 8.1';
  if (major === 6 && minor === 2) return 'Windows 8';
  if (major === 6 && minor === 1) return build >= 7601 ? 'Windows 7 SP1' : 'Windows 7';
  if (major === 6 && minor === 0) {
    if (build >= 6002) return 'Windows Vista SP2';
    if (build >= 6001) return 'Windows Vista SP1';
    return 'Windows Vista';
  }
  if (major === 5 && minor === 2) return 'Windows XP x64 / Server 2003';
  if (major === 5 && minor === 1) return build >= 2600 ? 'Windows XP SP2+' : 'Windows XP';
  if (major === 5 && minor === 0) return 'Windows 2000';

  return '';
}

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

  const friendlyName = getWindowsVersionName(normalized);
  return friendlyName ? `${friendlyName} (${normalized})` : normalized;
}

function extractWinDbgWindowsVersion(output) {
  const text = String(output || '');
  const osVersionMatch = text.match(/\bOS_VERSION:\s*([0-9]+(?:\.[0-9]+){1,3})\b/i);
  if (osVersionMatch) {
    return formatWindowsVersion(osVersionMatch[1]);
  }

  const kernelBannerMatch = text.match(/\bWindows\s+(?:[0-9]+\s+)?(?:NT\s+)?(?:Kernel\s+)?Version\s+([0-9]+(?:\.[0-9]+){1,3}|[0-9]{5})\b/i);
  if (kernelBannerMatch) {
    const rawVersion = kernelBannerMatch[1];
    const versionNumber = rawVersion.includes('.') ? rawVersion : `10.0.${rawVersion}`;
    const formatted = formatWindowsVersion(versionNumber);
    if (formatted) return formatted;
  }

  const productMatches = text.matchAll(/\bProductVersion:\s*([0-9]+(?:\.[0-9]+){1,3})\b/gi);
  for (const match of productMatches) {
    const formatted = formatWindowsVersion(match[1]);
    if (formatted) return formatted;
  }

  return null;
}

export {
  extractWinDbgWindowsVersion,
  formatWindowsVersion,
  getWindowsVersionName
};
