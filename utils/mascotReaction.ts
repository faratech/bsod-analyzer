import type { DumpFile } from '../types';
import type { ActId } from './mascotActs';
import { isForcedCrash } from './forcedCrash';

// How the report came out decides how he reacts when the scan finishes. First match wins.
// Sources for the codes: Microsoft Learn bug check reference (0x124 WHEA_UNCORRECTABLE_ERROR,
// 0x9C MACHINE_CHECK_EXCEPTION, 0x80 NMI_HARDWARE_FAILURE; 0x1A MEMORY_MANAGEMENT,
// 0x50 PAGE_FAULT_IN_NONPAGED_AREA, 0x4E PFN_LIST_CORRUPT; live dumps 0x117, 0x15F, 0x1A6).
const HARDWARE = new Set([0x124, 0x9C, 0x80]);
const MEMORY = new Set([0x1A, 0x50, 0x4E]);
const LIVE_DUMPS = new Set([0x117, 0x15F, 0x1A6, 0x11C8, 0x21C8]);
const KERNEL_DUMP_BYTES = 5 * 1024 * 1024;
// Windows' own drivers: a crash in one of them says little about a third party.
const MICROSOFT_DRIVER = /^(?:ntfs|fastfat|fltmgr|fileinfo|tcpip|ndis|netio|http|afd|storport|disk|partmgr|volsnap|dxgkrnl|dxgmms\d|win32k\w*|usb\w+|acpi|intelppm|processr|ksecdd|ksecpkg|ci)\.(?:sys|dll)$/i;

function bugCheckCode(file: DumpFile): number | undefined {
    const report = file.report as { bugCheck?: { code?: unknown }; bugCheckCode?: unknown } | undefined;
    const raw = `${report?.bugCheck?.code ?? report?.bugCheckCode ?? ''}`;
    const hex = /^\s*0x([0-9a-f]+)/i.exec(raw)?.[1];
    return hex ? parseInt(hex, 16) : undefined;
}

export function reactionFor(file?: DumpFile | null): ActId {
    const report = file?.report;
    if (!file || !report) return 'unsure';
    const code = bugCheckCode(file);
    // A forced crash (power button held, hotkey) records the action, not the cause: he says so.
    if (code !== undefined && isForcedCrash(code) && !LIVE_DUMPS.has(code)) return 'unsure';
    if (code !== undefined && LIVE_DUMPS.has(code)) return 'good';
    if ((code !== undefined && HARDWARE.has(code)) || report.hardwareError?.isHardwareError) return 'hot';
    if (code !== undefined && MEMORY.has(code)) return 'memory';
    const culprit = String(report.culprit ?? '').trim();
    const known = culprit !== '' && !/^unknown\b/i.test(culprit);
    if (known && /\.sys$/i.test(culprit) && !MICROSOFT_DRIVER.test(culprit)) return 'driver';
    if (known && (file.file?.size ?? 0) >= KERNEL_DUMP_BYTES) return 'lift';
    return 'unsure';
}
