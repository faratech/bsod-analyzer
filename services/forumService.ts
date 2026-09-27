/**
 * Related WindowsForum discussions for a finished report. Only the stop code,
 * its name and the faulting module name are sent (see /api/forum/related);
 * failures resolve to null so the report never depends on the forum.
 */
import { initializeSession, handleSessionError } from '../utils/sessionManager';

export interface RelatedKeys {
    code: string;
    name: string;
    module: string;
}

export type RelatedMatch = 'code+module' | 'module' | 'code';

export interface RelatedThread {
    threadId: number;
    title: string;
    snippet: string;
    url: string;
    match: RelatedMatch;
    kind: 'thread' | 'news' | 'tutorial';
}

export interface RelatedThreadsResponse {
    success: boolean;
    available: boolean;
    threads: RelatedThread[];
    boardUrl: string;
}

function relatedUrl(keys: RelatedKeys): string {
    const params = new URLSearchParams();
    if (keys.code) params.set('code', keys.code);
    if (keys.name) params.set('name', keys.name);
    if (keys.module) params.set('module', keys.module);
    return `/api/forum/related?${params.toString()}`;
}

// Successful lookups are reused for the page's lifetime, so collapsing and
// re-expanding a report (or re-rendering it) does not ask again.
const answered = new Map<string, RelatedThreadsResponse>();

export async function fetchRelatedThreads(keys: RelatedKeys, signal?: AbortSignal): Promise<RelatedThreadsResponse | null> {
    const url = relatedUrl(keys);
    const known = answered.get(url);
    if (known) return known;
    const request = () => fetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal
    });

    try {
        let response = await request();
        if (response.status === 401) {
            const errorData = await response.json().catch(() => ({}));
            if (handleSessionError(errorData) && await initializeSession(true)) {
                response = await request();
            }
        }
        if (!response.ok) return null;
        const data: RelatedThreadsResponse = await response.json();
        if (!data.success || !Array.isArray(data.threads)) return null;
        if (data.available) answered.set(url, data);
        return data;
    } catch (error) {
        if ((error as Error)?.name !== 'AbortError') {
            console.warn('[Forum] Related threads unavailable:', error);
        }
        return null;
    }
}
