import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DumpFile } from '../types';
import { TURNSTILE_SITE_KEY } from '../constants';
import { getReportFacts } from '../utils/reportFacts';
import {
    BSOD_AI_TURNSTILE_ACTION, BsodAiError, BsodAiReport, askBsodAi, createBsodAiPass, getBsodAiStatus,
} from '../services/bsodAiService';
import CloudflareTurnstile, { type CloudflareTurnstileHandle } from './CloudflareTurnstile';
import ChatMarkdown from './ChatMarkdown';
import Mascot from './Mascot';

interface Message {
    role: 'user' | 'assistant';
    text: string;
    evidence?: string[];
}

interface Notice {
    kind: 'info' | 'warn';
    text: string;
}

const CHIPS = ['Is it my hardware?', 'Which driver is it?', 'How do I fix it?', 'Can I ignore it?'];
const MAX_QUESTION = 500;

// The report as the visitor sees it. The server adds the dump's own evidence when this session uploaded it.
function reportFor(file: DumpFile): BsodAiReport {
    const facts = getReportFacts(file);
    if (!facts) return {};
    return { title: facts.title, bugcheck: facts.bugcheck, culprit: facts.culprit, primaryCause: facts.primaryCause, windows: facts.windowsVersion, actions: facts.topActions };
}

// Ask BSOD AI about a crash that was just analyzed. Closed by default: the wand
// in the summary strip opens it. A Turnstile pass comes first (one challenge per
// visit; the server remembers it for a few minutes), then questions.
const BsodAiChat: React.FC<{ files: DumpFile[]; onClose: () => void }> = ({ files, onClose }) => {
    const [fileIndex, setFileIndex] = useState(0);
    const file = files[Math.min(fileIndex, files.length - 1)];
    const [phase, setPhase] = useState<'checking' | 'verify' | 'ready' | 'off'>('checking');
    const [messages, setMessages] = useState<Message[]>([]);
    // The answer so far while it streams in; null when no answer is on its way.
    const [streaming, setStreaming] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [remaining, setRemaining] = useState<number | undefined>();
    const [limit, setLimit] = useState<number | undefined>();
    const [mood, setMood] = useState<'rest' | 'shrug' | undefined>();
    const turnstile = useRef<CloudflareTurnstileHandle>(null);
    const body = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const alive = useRef(true);
    const streamedAny = useRef('');
    useEffect(() => () => { alive.current = false; }, []);

    useEffect(() => {
        getBsodAiStatus().then(status => {
            if (!alive.current) return;
            setLimit(status.limit);
            setRemaining(status.limit);
            setPhase(!status.enabled ? 'off' : status.pass ? 'ready' : 'verify');
        });
    }, []);

    useEffect(() => { if (phase === 'ready') input.current?.focus(); }, [phase]);

    // The conversation is about one crash: another file starts a new one.
    useEffect(() => { setMessages([]); setNotice(null); setMood(undefined); setStreaming(null); }, [fileIndex]);

    useEffect(() => { body.current?.scrollTo?.({ top: body.current.scrollHeight }); }, [messages, streaming, busy, notice]);

    const onPass = useCallback(async (token: string) => {
        try {
            await createBsodAiPass(token);
            if (alive.current) { setNotice(null); setPhase('ready'); }
        } catch (error) {
            if (!alive.current) return;
            const locked = error instanceof BsodAiError && error.code === 'BSOD_AI_LOCKED';
            setNotice({ kind: 'warn', text: locked ? 'BSOD AI is taking a break. Try again later.' : 'The security check did not go through. Try again.' });
            if (!locked) turnstile.current?.reset();
        }
    }, []);

    const ask = useCallback(async (raw: string) => {
        const question = raw.trim();
        if (!question || busy || !file) return;
        const history = messages.map(m => ({ role: m.role, text: m.text }));
        const withQuestion: Message[] = [...messages, { role: 'user', text: question }];
        setMessages(withQuestion);
        setDraft('');
        setNotice(null);
        setMood(undefined);
        setBusy(true);
        streamedAny.current = '';
        try {
            const result = await askBsodAi({ question, history, report: reportFor(file), fileHash: file.fileHash }, piece => {
                streamedAny.current += piece;
                if (alive.current) setStreaming(streamedAny.current);
            });
            if (!alive.current) return;
            if (result.remaining !== undefined) setRemaining(result.remaining);
            setMood(result.refused ? 'shrug' : undefined);
            const next: Message[] = [...withQuestion, { role: 'assistant', text: result.answer, evidence: result.evidence }];
            setMessages(next);
        } catch (error) {
            if (!alive.current) return;
            const code = error instanceof BsodAiError ? error.code : 'BSOD_AI_FAILED';
            // Part of an answer on screen stays as an unfinished reply; otherwise the question
            // goes back into the box: nothing was spent unless the notice says so.
            if (streamedAny.current) {
                setMessages([...withQuestion, { role: 'assistant', text: streamedAny.current }]);
            } else {
                setMessages(messages);
                setDraft(question);
            }
            if (code === 'AI_PASS_REQUIRED') { setPhase('verify'); setNotice({ kind: 'info', text: 'One more quick security check, then ask again.' }); }
            else if (code === 'BSOD_AI_RESTING') { setMood('rest'); setNotice({ kind: 'info', text: 'BSOD AI is resting. It is out of free capacity right now, so your question was not counted. Your report is unaffected. Try again in a few minutes.' }); }
            else if (code === 'BSOD_AI_QUOTA') { setMood('rest'); setRemaining(0); setNotice({ kind: 'warn', text: 'That was your questions for this hour. BSOD AI is catching its breath. Try again later.' }); }
            else if (code === 'BSOD_AI_LOCKED') { setMood('rest'); setNotice({ kind: 'warn', text: 'BSOD AI is taking a break after too many odd questions. Try again later.' }); }
            else if (code === 'BSOD_AI_BUSY') setNotice({ kind: 'info', text: 'One question at a time, please.' });
            else setNotice({ kind: 'info', text: error instanceof BsodAiError ? error.message : 'BSOD AI could not answer. Try again.' });
        } finally {
            if (alive.current) { setBusy(false); setStreaming(null); }
        }
    }, [busy, file, messages]);

    if (!file || phase === 'off') return null;
    const facts = getReportFacts(file);
    const mascot = busy ? (streaming ? 'talk' : 'think') : mood;
    const spent = remaining !== undefined && remaining <= 0;

    return (
        <section id="bsod-ai-chat" className="ai-chat" aria-label="Ask BSOD AI">
            <header className="ai-head">
                <div className="ai-avatar"><Mascot state={mascot} /></div>
                <div className="ai-title">
                    <b>Ask BSOD AI</b>
                    <small>{facts?.bugcheck || 'Your crash'} · {file.displayName || file.file.name}</small>
                </div>
                {files.length > 1 && (
                    <select aria-label="Crash to ask about" value={fileIndex} onChange={e => setFileIndex(Number(e.target.value))}>
                        {files.map((f, i) => <option key={f.id} value={i}>{f.displayName || f.file.name}</option>)}
                    </select>
                )}
                <button type="button" className="ai-x" aria-label="Close BSOD AI" onClick={onClose}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
            </header>

            <div className="ai-body" role="log" aria-live="polite" aria-label="Conversation" ref={body}>
                {phase === 'ready' && messages.length === 0 && !busy && (
                    <div className="ai-hello">
                        <div className="ai-hello-mascot"><Mascot state="happy" /></div>
                        <b>Hi, I'm BSOD AI.</b>
                        <p>I read your whole crash report. Ask me anything about it, in plain English.</p>
                    </div>
                )}
                {messages.map((m, i) => (
                    <div key={i} className={`ai-msg ${m.role === 'user' ? 'ai-me' : 'ai-gm'}`}>
                        {m.role === 'user' ? <span>{m.text}</span> : <ChatMarkdown text={m.text} />}
                        {m.evidence && m.evidence.length > 0 && (
                            <div className="ai-ev">Based on: {m.evidence.join(' · ')}</div>
                        )}
                    </div>
                ))}
                {busy && !streaming && <div className="ai-msg ai-gm" aria-label="BSOD AI is thinking"><span className="ai-dots" aria-hidden="true"><i /><i /><i /></span></div>}
                {/* Hidden from screen readers while it grows, so the finished answer is announced once, whole. */}
                {busy && streaming && <div className="ai-msg ai-gm" aria-hidden="true"><ChatMarkdown text={streaming} /><span className="ai-caret" /></div>}
                {notice && <p className={`ai-note ${notice.kind}`} role="status">{notice.text}</p>}
            </div>

            {phase === 'verify' && (
                <div className="ai-verify">
                    <p>One quick security check, then ask away.</p>
                    <CloudflareTurnstile ref={turnstile} siteKey={TURNSTILE_SITE_KEY} action={BSOD_AI_TURNSTILE_ACTION} onSuccess={onPass}
                        onError={() => setNotice({ kind: 'warn', text: 'The security check could not load. Reload the page and try again.' })} />
                </div>
            )}

            {phase === 'ready' && messages.length === 0 && !busy && (
                <div className="ai-chips">
                    {CHIPS.map(chip => <button key={chip} type="button" className="ai-chip" onClick={() => ask(chip)}>{chip}</button>)}
                </div>
            )}

            <footer className="ai-foot">
                <form onSubmit={e => { e.preventDefault(); ask(draft); }}>
                    <label className="sr-only" htmlFor="bsod-ai-input">Ask about this crash</label>
                    <div className="ai-comp">
                        <input id="bsod-ai-input" ref={input} type="text" maxLength={MAX_QUESTION} autoComplete="off" placeholder={phase === 'ready' ? 'Ask about this crash' : 'Complete the security check first'}
                            value={draft} onChange={e => setDraft(e.target.value)} disabled={phase !== 'ready' || spent} />
                        <button type="submit" className="ai-send" aria-label="Send question" disabled={phase !== 'ready' || spent || busy || !draft.trim()}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                        </button>
                    </div>
                </form>
                <div className="ai-meta">
                    <span>{remaining !== undefined && limit !== undefined ? `${remaining} of ${limit} questions left this hour` : ''}</span>
                    <span>gpt-6-luna · AI can be wrong</span>
                </div>
            </footer>
        </section>
    );
};

export default BsodAiChat;
