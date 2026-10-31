// Client for the BSOD AI chat (server/bsodAiRoute.js): a status check, the
// Turnstile pass, and one question at a time. The server owns the model, the
// quotas and the safety rules; this only carries the session cookies, the
// data-use terms and the visitor's own text.
import { dataUseHeaders } from '../utils/dataUse';
import { handleSessionError, initializeSession } from '../utils/sessionManager';
import { getFileHandle } from './windbgService';

export const BSOD_AI_TURNSTILE_ACTION = 'bsod-ai';

export interface BsodAiStatus {
    enabled: boolean;
    pass: boolean;
    limit?: number;
    windowMinutes?: number;
    model?: string;
}

export interface BsodAiTurn {
    role: 'user' | 'assistant';
    text: string;
}

// The report as the visitor sees it: the server adds the dump's own evidence when it can.
export interface BsodAiReport {
    title?: string;
    bugcheck?: string;
    culprit?: string;
    primaryCause?: string;
    windows?: string;
    actions?: string[];
}

export interface BsodAiAnswer {
    answer: string;
    evidence: string[];
    refused: boolean;
    remaining?: number;
}

export class BsodAiError extends Error {
    code: string;
    retryAfterMs?: number;
    constructor(code: string, message: string, retryAfterMs?: number) {
        super(message);
        this.name = 'BsodAiError';
        this.code = code;
        this.retryAfterMs = retryAfterMs;
    }
}

async function send(path: string, init: { method: string; body?: unknown }, retried = false): Promise<any> {
    let response: Response;
    try {
        response = await fetch(path, {
            method: init.method,
            headers: { 'Content-Type': 'application/json', ...dataUseHeaders() },
            credentials: 'include',
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
    } catch {
        throw new BsodAiError('NETWORK', 'Could not reach BSOD AI. Check your connection and try again.');
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    // An expired session is renewed once, the way the analysis calls do.
    if (response.status === 401 && !retried && handleSessionError(data) && await initializeSession(true)) {
        return send(path, init, true);
    }
    const retryAfter = Number(response.headers.get('Retry-After'));
    throw new BsodAiError(
        typeof data?.code === 'string' ? data.code : `HTTP_${response.status}`,
        typeof data?.error === 'string' ? data.error : 'BSOD AI could not answer.',
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
    );
}

export async function getBsodAiStatus(): Promise<BsodAiStatus> {
    try {
        const data = await send('/api/bsod-ai/status', { method: 'GET' });
        return { enabled: data?.enabled === true, pass: data?.pass === true, limit: data?.limit, windowMinutes: data?.windowMinutes, model: data?.model };
    } catch {
        return { enabled: false, pass: false };
    }
}

export async function createBsodAiPass(token: string): Promise<void> {
    await send('/api/bsod-ai/pass', { method: 'POST', body: { token, action: BSOD_AI_TURNSTILE_ACTION } });
}

export async function askBsodAi(input: { question: string; history: BsodAiTurn[]; report: BsodAiReport; fileHash?: string }): Promise<BsodAiAnswer> {
    const data = await send('/api/bsod-ai/ask', {
        method: 'POST',
        body: {
            question: input.question,
            history: input.history,
            report: input.report,
            fileHash: input.fileHash,
            fileHandle: getFileHandle(input.fileHash),
        },
    });
    return {
        answer: String(data?.answer ?? ''),
        evidence: Array.isArray(data?.evidence) ? data.evidence.filter((item: unknown) => typeof item === 'string') : [],
        refused: data?.refused === true,
        remaining: typeof data?.remaining === 'number' ? data.remaining : undefined,
    };
}
