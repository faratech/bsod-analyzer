import React, { useEffect, useMemo, useState } from 'react';
import type { DumpFile } from '../types';
import { fetchRelatedThreads, type RelatedKeys, type RelatedMatch, type RelatedThread } from '../services/forumService';
import { generateForumReport } from '../utils/reportFacts';
import { BSOD_FORUM_URL, bsodPostThreadUrl, forumThreadTitle, relatedKeysFromReport, withForumUtm } from '../shared/forumLinks.js';

const MAX_SHOWN = 4;

const MATCH_LABELS: Record<RelatedMatch, string> = {
    'code+module': 'Same stop code & driver',
    module: 'Same driver',
    code: 'Same stop code',
};

type LookupState = 'loading' | 'matched' | 'none' | 'unavailable';

/**
 * WindowsForum threads about the same stop code and/or faulting driver, plus a
 * one-click "Ask the community" handoff (copy the forum-safe summary, open a
 * new thread on the BSOD board). The lookup is best-effort: when the forum
 * search is unavailable only the call to action is shown.
 */
const RelatedDiscussions: React.FC<{ dumpFile: DumpFile }> = ({ dumpFile }) => {
    const keys = useMemo(() => relatedKeysFromReport(dumpFile.report) as RelatedKeys | null, [dumpFile.report]);
    const keyString = keys ? JSON.stringify(keys) : '';
    const [lookup, setLookup] = useState<LookupState>(keys ? 'loading' : 'unavailable');
    const [threads, setThreads] = useState<RelatedThread[]>([]);
    const [askStatus, setAskStatus] = useState<'idle' | 'copied' | 'copy-failed'>('idle');

    useEffect(() => {
        if (!keys) {
            setThreads([]);
            setLookup('unavailable');
            return;
        }
        const controller = new AbortController();
        setLookup('loading');
        fetchRelatedThreads(keys, controller.signal).then(result => {
            if (controller.signal.aborted) return;
            const found = result?.available ? result.threads.slice(0, MAX_SHOWN) : [];
            setThreads(found);
            setLookup(!result?.available ? 'unavailable' : found.length ? 'matched' : 'none');
        });
        return () => controller.abort();
    }, [keyString]); // keyString captures every field of keys

    const handleAsk = async () => {
        // Copy first: clipboard writes need the page focused, and the new tab
        // still opens within the click's user-activation window.
        let copied = false;
        try {
            await navigator.clipboard.writeText(generateForumReport(dumpFile));
            copied = true;
        } catch {
            copied = false;
        }
        window.open(bsodPostThreadUrl(forumThreadTitle(keys || {})), '_blank', 'noopener');
        setAskStatus(copied ? 'copied' : 'copy-failed');
    };

    const askText = lookup === 'matched'
        ? 'Still stuck? Post this analysis and forum members can help you work through it.'
        : lookup === 'none'
            ? 'No forum threads match this crash yet. Post this analysis and forum members can help you work through it.'
            : 'Get help from other members: post this analysis on WindowsForum and ask what to try next.';

    return (
        <section className="related-discussions" aria-label="Related WindowsForum discussions">
            <div className="related-discussions-header">
                <div className="report-section-label">Discussed on WindowsForum</div>
                <a
                    className="related-discussions-board"
                    href={withForumUtm(BSOD_FORUM_URL, 'bsod_board')}
                    target="_blank"
                    rel="noopener"
                >
                    Browse the BSOD forum
                </a>
            </div>

            {lookup === 'loading' && (
                <p className="related-discussions-note">Looking for forum threads about this crash…</p>
            )}

            {lookup === 'matched' && (
                <ul className="related-discussions-list">
                    {threads.map(thread => (
                        <li key={thread.threadId} className="related-thread">
                            <a className="related-thread-title" href={thread.url} target="_blank" rel="noopener">
                                {thread.title}
                            </a>
                            <div className="related-thread-meta">
                                <span className={`related-match related-match-${thread.match === 'code+module' ? 'both' : thread.match}`}>
                                    {MATCH_LABELS[thread.match] || 'Related'}
                                </span>
                                {thread.kind !== 'thread' && (
                                    <span className="related-kind">{thread.kind === 'news' ? 'News' : 'Tutorial'}</span>
                                )}
                            </div>
                            {thread.snippet && <p className="related-thread-snippet">{thread.snippet}</p>}
                        </li>
                    ))}
                </ul>
            )}

            <div className="related-discussions-ask">
                <p>{askText}</p>
                <button type="button" className="btn btn-primary related-ask-btn" onClick={handleAsk}>
                    Ask the community
                </button>
            </div>

            {askStatus !== 'idle' && (
                <p className="related-discussions-note" role="status">
                    {askStatus === 'copied'
                        ? 'Summary copied. Paste it into your new thread (Ctrl+V), then add what you were doing when it crashed.'
                        : 'Could not copy automatically. Use "Copy for Forum" above, then paste it into your new thread.'}
                </p>
            )}
        </section>
    );
};

export default RelatedDiscussions;
