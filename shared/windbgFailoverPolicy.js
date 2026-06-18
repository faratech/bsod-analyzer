export const DEFAULT_LARGE_DUMP_SAMPLE_BYTES = 1024 * 1024;

export function shouldUseLightweightAiFailover(fileSize, fullLocalLimitBytes) {
  return Number.isFinite(fileSize) &&
    Number.isFinite(fullLocalLimitBytes) &&
    fileSize > fullLocalLimitBytes;
}

export function getLargeDumpSampleRanges(fileSize, sampleBytes = DEFAULT_LARGE_DUMP_SAMPLE_BYTES) {
  const size = Math.max(0, Math.floor(Number(fileSize) || 0));
  const budget = Math.max(1, Math.floor(Number(sampleBytes) || DEFAULT_LARGE_DUMP_SAMPLE_BYTES));

  if (size <= budget) {
    return size > 0 ? [{ label: 'full', start: 0, end: size }] : [];
  }

  const headBytes = Math.max(1, Math.floor(budget / 2));
  const tailBytes = Math.max(1, budget - headBytes);
  const headEnd = Math.min(headBytes, size);
  const tailStart = Math.max(headEnd, size - tailBytes);

  return [
    { label: 'head', start: 0, end: headEnd },
    { label: 'tail', start: tailStart, end: size }
  ].filter(range => range.end > range.start);
}
