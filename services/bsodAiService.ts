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

// Reads a text/event-stream body: `delta` events go to onDelta, `done` is the
// result, `error` fails the call. The text already shown stays on screen.
async function readEvents(response: Response, onDelta: (text: string) => void): Promise<any> {
    const reader = response.body?.getReader();
    if (!reader) throw new BsodAiError('BSOD_AI_FAILED', 'BSOD AI could not answer.');
    const decoder = new TextDecoder();
    let buffered = '';
    let result: any;
    const handle = (block: string) => {
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const raw = /^data: (.+)$/m.exec(block)?.[1];
        if (!event || !raw) return;
        let data: any;
        try { data = JSON.parse(raw); } catch { return; }
        if (event === 'delta' && typeof data?.text === 'string') onDelta(data.text);
        else if (event === 'done') result = data;
        else if (event === 'error') throw new BsodAiError(typeof data?.code === 'string' ? data.code : 'BSOD_AI_FAILED', typeof data?.error === 'string' ? data.error : 'BSOD AI stopped mid-answer. Try again.');
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffered.indexOf('\n\n')) >= 0) {
            handle(buffered.slice(0, end));
            buffered = buffered.slice(end + 2);
        }
    }
    if (!result) throw new BsodAiError('BSOD_AI_FAILED', 'BSOD AI stopped mid-answer. Try again.');
    return result;
}

async function send(path: string, init: { method: string; body?: unknown; onDelta?: (text: string) => void }, retried = false): Promise<any> {
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
    // A streamed answer is only used once it has started; every earlier outcome is plain JSON.
    if (response.ok && init.onDelta && response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
        try {
            return await readEvents(response, init.onDelta);
        } catch (error) {
            if (error instanceof BsodAiError) throw error;
            throw new BsodAiError('NETWORK', 'The connection dropped mid-answer. Try again.');
        }
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

// With onDelta the answer is streamed: onDelta gets each piece as it is released,
// and the returned answer is the complete, final text.
export async function askBsodAi(input: { question: string; history: BsodAiTurn[]; report: BsodAiReport; fileHash?: string }, onDelta?: (text: string) => void): Promise<BsodAiAnswer> {
    const data = await send('/api/bsod-ai/ask', {
        method: 'POST',
        onDelta,
        body: {
            stream: onDelta ? true : undefined,
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
