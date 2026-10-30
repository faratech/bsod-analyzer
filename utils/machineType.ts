/**
 * Dump header MachineImageType -> architecture label (winnt.h
 * IMAGE_FILE_MACHINE_* values). Leaf module, shared by the kernel dump parser
 * and the AI prompt. Unknown values are reported as such in hex, never
 * guessed as x86.
 */

export const IMAGE_FILE_MACHINE_I386 = 0x014C;
export const IMAGE_FILE_MACHINE_ARMNT = 0x01C4;
export const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
export const IMAGE_FILE_MACHINE_ARM64 = 0xAA64;

const MACHINE_TYPE_LABELS: Record<number, string> = {
    [IMAGE_FILE_MACHINE_I386]: 'x86',
    [IMAGE_FILE_MACHINE_AMD64]: 'x64',
    [IMAGE_FILE_MACHINE_ARM64]: 'ARM64',
    [IMAGE_FILE_MACHINE_ARMNT]: 'ARM (Thumb-2)',
};

const hex = (value: number) => `0x${(value >>> 0).toString(16).toUpperCase()}`;

/** 'x86', 'x64', 'ARM64', 'ARM (Thumb-2)', or 'unknown (0x....)'. */
export function machineTypeLabel(machineImageType: number): string {
    return MACHINE_TYPE_LABELS[machineImageType] ?? `unknown (${hex(machineImageType)})`;
}

/** Prompt form: the value in hex followed by its label, e.g. '0xAA64 (ARM64)'. */
export function formatMachineType(machineImageType: number): string {
    return `${hex(machineImageType)} (${machineTypeLabel(machineImageType)})`;
}
