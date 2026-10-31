// Bug checks a person forces on a system that has hung, so a dump gets written.
// They record the forced action, not the problem that came first; the AI
// prompts say so (shared/promptTemplates.js, FORCED_CRASH_GUIDANCE).
//
// Sources: Microsoft Learn, "Bug Check 0x1C8: MANUALLY_INITIATED_POWER_BUTTON_HOLD"
// (parameter 1 = milliseconds the power button was held, parameter 2 = pointer to
// nt!_POP_POWER_BUTTON_TRIAGE_BLOCK, 3 and 4 reserved), "Bug Check 0xE2:
// MANUALLY_INITIATED_CRASH" (no parameters), and "Forcing a System Crash with the
// Power Button" (0x11C8, the live-dump form). Leaf module: imports nothing, so
// any parser or service may use it.

const FORCED_CRASH_CODES = new Set([0xE2, 0x1C8, 0x11C8, 0x21C8, 0xDEADDEAD]);

export function isForcedCrash(code: number): boolean {
    return FORCED_CRASH_CODES.has(code >>> 0);
}

const NOT_A_FAULT = 'This crash was forced by a person. It records that action, not what went wrong first: the system had most likely already hung or stopped responding, and nothing in this bug check says why. Do not treat it as the cause.';

export function describeForcedCrashParameters(code: number, params: bigint[]): string | undefined {
    if ((code >>> 0) === 0x1C8) {
        const ms = Number(params[0] ?? 0n);
        return `- Arg1: Time the power button was held, in milliseconds (${ms}, about ${(ms / 1000).toFixed(1)} seconds)
- Arg2: Pointer to nt!_POP_POWER_BUTTON_TRIAGE_BLOCK (0x${(params[1] ?? 0n).toString(16)})
- Arg3: Reserved
- Arg4: Reserved
**The user held the power button so Windows would capture a dump before the firmware hard-reset the machine. ${NOT_A_FAULT}**`;
    }
    if ((code >>> 0) === 0xE2) {
        return `- No parameters
**The crash was started deliberately from the keyboard hotkey (rightmost Ctrl, then Scroll Lock twice) or from a debugger. ${NOT_A_FAULT}**`;
    }
    return undefined;
}

export function describeForcedCrash(code: number): string | undefined {
    switch (code >>> 0) {
        case 0x1C8: return 'a crash the user forced by holding the power button, which records that action and not the problem that came first';
        case 0xE2: return 'a crash the user forced from the keyboard or a debugger, which records that action and not a fault';
        default: return undefined;
    }
}
