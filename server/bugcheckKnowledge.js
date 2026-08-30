// Human-readable explanations for the most common Windows bugcheck codes,
// used to enrich the public crash-statistics snapshot. Keys are canonical
// short-hex codes exactly as normalizeStopCode() emits them ('0x1A').
// Descriptions are deliberately one-liners a forum reader can act on.
const BUGCHECK_MEANINGS = {
  '0xA': 'A driver or hardware accessed memory at an invalid interrupt request level, usually a buggy driver.',
  '0x1A': 'Serious memory management corruption — faulty RAM, driver memory misuse, or overheating.',
  '0x1E': 'Kernel caught an exception a driver failed to handle; commonly drivers or low disk space.',
  '0x3B': 'A system service (driver or Windows component) crashed while running — often GPU drivers or antivirus.',
  '0x50': 'A driver referenced memory that should have been there but wasn\'t — bad RAM, drivers, or antivirus.',
  '0x7E': 'A system thread raised an exception handlers didn\'t cover — typically a buggy driver.',
  '0x7F': 'Double fault in the kernel, frequently caused by stack overflow from nested drivers or low memory.',
  '0x9F': 'A driver failed to complete power state transitions — classic culprit is an outdated chipset/GPU driver.',
  '0xA0': 'Power management internal error, tied to sleep/hibernation (ACPI) issues.',
  '0xBE': 'A driver attempted to write to read-only memory.',
  '0xC2': 'Bad memory pool allocation by a driver — freed memory was reused or mismanaged.',
  '0xC5': 'A driver referenced paged memory at too high an interrupt level — classic broken-driver signature.',
  '0xC9': 'Driver verifier caught a driver breaking allocation rules (only with verifier enabled).',
  '0xD1': 'A driver accessed pageable memory at DISPATCH_LEVEL — the most common driver-crash code.',
  '0xEF': 'A critical system process died — failing drivers, disk corruption, or malware.',
  '0x101': 'A clock interrupt was lost on a secondary processor — often overclocking/instability.',
  '0x109': 'The kernel detected critical structure corruption — unstable overclock/RAM or kernel-mode tampering.',
  '0x116': 'GPU stopped responding and the driver was recovered twice — display driver TDR failure.',
  '0x117': 'Video driver failed to reset in time after a hang (TDR delay exceeded).',
  '0x119': 'The video scheduler detected a fatal programming violation by a GPU driver.',
  '0x124': 'WHEA reported an uncorrectable hardware error — CPU/motherboard/RAM/GPU hardware fault.',
  '0x133': 'A DPC routine ran past its deadline — drivers, storage latency, or power throttling.',
  '0x139': 'Kernel security check caught a stack cookie/boundary violation in a driver.',
  '0x13A': 'Kernel mode heap corruption detected.',
  '0x154': 'Unexpected store exception — commonly SSD firmware/drivers, or memory.',
  '0x15F': 'Connected standby exited unexpectedly — power/driver related.',
  '0x18B': 'Secure kernel observed a invalid state (VBS/HVCI systems).',
  '0x192': 'Kernel power transition targeted an invalid processor state.',
  '0x19C': 'A process running in the secure world terminated unexpectedly.',
  '0x1A0': 'TPM-related critical device failure.',
  '0x1A6': 'A video driver took too long on a queued packet (TDR variant).',
};

const LABEL_FALLBACKS = [
  { match: /MEMORY_CORRUPTION|CORRUPT/, meaning: 'Memory corruption detected — suspect RAM stability or an overwriting driver.' },
  { match: /^AV_/, meaning: 'An access violation: code jumped to or read an address it shouldn\'t — usually the named driver.' },
  { match: /POWER|SHUTDOWN|SLEEP/, meaning: 'Failure during a power transition — check power-management and chipset drivers.' },
  { match: /FILESYSTEM|STORE|DISK/, meaning: 'Storage/filesystem fault — check disk health and storage filter drivers.' },
  { match: /DISPLAY|VIDEO|GPU|DXG/, meaning: 'Graphics-stack failure — GPU driver, VRAM, or display pipeline.' },
  { match: /NETWORK|NDIS|TCPIP/, meaning: 'Networking-stack failure — NIC drivers or network filter software.' },
];

// Case-insensitive index: '0x1a'.toUpperCase() is '0X1A', so the index must
// be normalized the same way (the literal keys above keep their readable form).
const BUGCHECK_MEANINGS_INDEX = new Map(
  Object.entries(BUGCHECK_MEANINGS).map(([key, meaning]) => [key.toUpperCase(), meaning])
);

export function describeBugcheck(code, label) {
  const known = code && BUGCHECK_MEANINGS_INDEX.get(String(code).trim().toUpperCase());
  if (known) return known;
  const labelText = String(label || '');
  const fallback = LABEL_FALLBACKS.find(entry => entry.match.test(labelText));
  if (fallback) return fallback.meaning;
  // Unknown code with a label: describe generically. The label itself is
  // attacker-supplied dump text and is never echoed into the public snapshot.
  if (labelText) {
    return 'A kernel fault whose details live in the bugcheck parameters — treat the named module as the lead suspect.';
  }
  return undefined;
}
