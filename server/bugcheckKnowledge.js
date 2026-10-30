// Human-readable explanations for the most common Windows bugcheck codes,
// used to enrich the public crash-statistics snapshot. Keys are canonical
// short-hex codes exactly as normalizeStopCode() emits them ('0x1A').
// Descriptions are deliberately one-liners a forum reader can act on.
// Each entry must describe the code named in utils/bugCheckCodes.ts, per the
// Microsoft Learn bug check / kernel live dump reference pages
// (tests/bugcheckKnowledge.test.mjs pins the keys and keyword sanity checks).
export const BUGCHECK_MEANINGS = {
  '0xA': 'A driver or hardware accessed memory at an invalid interrupt request level, usually a buggy driver.',
  '0x1A': 'Serious memory management corruption — faulty RAM, driver memory misuse, or overheating.',
  '0x1E': 'Kernel caught an exception a driver failed to handle; commonly drivers or low disk space.',
  '0x3B': 'A system service (driver or Windows component) crashed while running — often GPU drivers or antivirus.',
  '0x50': 'A driver referenced memory that should have been there but wasn\'t — bad RAM, drivers, or antivirus.',
  '0x7E': 'A system thread raised an exception handlers didn\'t cover — typically a buggy driver.',
  '0x7F': 'The CPU raised a trap the kernel did not catch — most often a double fault (Arg1 = 8) from a kernel stack overflow, or failing hardware.',
  '0x9F': 'A driver failed to complete power state transitions — classic culprit is an outdated chipset/GPU driver.',
  '0xA0': 'Power management internal error, tied to sleep/hibernation (ACPI) issues.',
  '0xBE': 'A driver attempted to write to read-only memory.',
  '0xC2': 'Bad memory pool allocation by a driver — freed memory was reused or mismanaged.',
  '0xC5': 'A driver corrupted the kernel memory pool; the system then touched invalid memory at too high an interrupt level.',
  '0xC9': 'Driver Verifier I/O Verification caught a driver violating I/O rules (only with Driver Verifier enabled).',
  '0xD1': 'A driver accessed pageable memory at DISPATCH_LEVEL — the most common driver-crash code.',
  '0xEF': 'A critical system process died — failing drivers, disk corruption, or malware.',
  '0x101': 'A clock interrupt was lost on a secondary processor — often overclocking/instability.',
  '0x109': 'The kernel detected critical structure corruption — unstable overclock/RAM or kernel-mode tampering.',
  '0x116': 'The GPU stopped responding and the attempt to reset the display driver failed — GPU driver, overheating, or power.',
  '0x117': 'Live dump: the display driver did not respond in time and Windows recovered it (TDR); the system kept running.',
  '0x119': 'The video scheduler detected a fatal programming violation by a GPU driver.',
  '0x124': 'WHEA reported an uncorrectable hardware error — CPU/motherboard/RAM/GPU hardware fault.',
  '0x133': 'A DPC routine ran past its deadline — drivers, storage latency, or power throttling.',
  '0x139': 'The kernel detected corruption of a critical data structure (e.g. a corrupted list entry or stack buffer overrun) — usually a driver.',
  '0x13A': 'Kernel mode heap corruption detected.',
  '0x154': 'Unexpected store exception — commonly SSD firmware/drivers, or memory.',
  '0x15F': 'Live dump: a connected standby watchdog timed out because the system stayed out of its deepest idle state too long — check device drivers.',
  '0x18B': 'The secure kernel encountered a fatal error (VBS/HVCI systems).',
  '0x192': 'A lock tracked by AutoBoost was acquired while running at DISPATCH_LEVEL or above — a driver locking bug.',
  '0x19C': 'Win32k did not turn the monitor on in time (power watchdog) — display or GPU driver stuck on a power transition.',
  '0x1A0': 'The terminal topology manager saw device operations (display, input) miss their timeout — often display or input drivers.',
  '0x1A6': 'Live dump: the Bluetooth radio driver (bthport.sys) reset the radio to recover from an internal error; the system kept running.',
  '0x1C8': 'The power button was held to force a crash dump — usually because the system hung; the dump shows what was stuck.',
};

const LABEL_FALLBACKS = [
  { match: /MEMORY_CORRUPTION|CORRUPT/, meaning: 'Memory corruption detected — suspect RAM stability or an overwriting driver.' },
  { match: /^AV_/, meaning: 'An access violation: code jumped to or read an address it shouldn\'t — usually the named driver.' },
  { match: /POWER|SHUTDOWN|SLEEP/, meaning: 'Failure during a power transition — check power-management and chipset drivers.' },
  // Network and inter-process file systems (redirector, DFS, MUP, named pipes,
  // mailslots) are not about local disks; keep them off the storage line.
  { match: /^(?:RDR|DFS|MUP|NPFS|MAILSLOT)_FILE_SYSTEM$/, meaning: 'Network or inter-process file-system fault (redirector, DFS, named pipes, mailslots) — check network and filter drivers.' },
  // Microsoft names say FILE_SYSTEM (NTFS_FILE_SYSTEM); RAMDISK is a boot RAM disk.
  { match: /FILE_?SYSTEM|STORE|(?<!RAM)DISK/, meaning: 'Storage/filesystem fault — check disk health and storage filter drivers.' },
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
