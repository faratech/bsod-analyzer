import React, { useState, useEffect, useRef } from 'react';

interface AnalysisProgressProps {
    stage: 'uploading' | 'queued' | 'processing' | 'downloading' | 'analyzing' | 'complete';
    message?: string;
    startTime?: number;
    percentage?: number;
}

const FACTS = [
    'WinDBG is the debugger Microsoft engineers use to investigate Windows crashes.',
    'Minidumps are only a few hundred KB, yet they record the stop code, stack and loaded drivers.',
    'A kernel dump is a snapshot of kernel memory at the moment Windows crashed.',
    'IRQL_NOT_LESS_OR_EQUAL usually means a driver touched memory it should not have.',
];

// The first five rows are the steps beside the grid; maxSeconds is a stage's own
// budget for the "taking longer" note.
const STAGES = [
    { key: 'uploading', title: 'Uploading Dump File', description: 'Securely transferring your crash dump to the analysis server...', label: 'Upload', typical: 'typically 5–15 seconds', maxSeconds: 15 },
    { key: 'queued', title: 'Queued for Analysis', description: 'Your file is in the queue and will be processed shortly...', label: 'Queue', typical: 'usually under a minute', maxSeconds: 60 },
    { key: 'processing', title: 'WinDBG Analysis in Progress', description: 'Running professional debugging commands on your crash dump...', label: 'WinDBG', typical: 'usually 30–90 seconds', maxSeconds: 90 },
    { key: 'downloading', title: 'Downloading Results', description: 'Retrieving the detailed analysis from WinDBG...', label: 'Fetch', typical: 'a few seconds', maxSeconds: 10 },
    { key: 'analyzing', title: 'AI Analysis', description: 'Our AI is interpreting the crash data for you...', label: 'AI', typical: 'usually 10–30 seconds', maxSeconds: 30 },
    { key: 'complete', title: 'Analysis Complete', description: 'Your crash analysis is ready!', label: '', typical: '', maxSeconds: 0 },
];

// Drops a trailing elapsed counter: `— 40s elapsed` or `(40s)`.
const ELAPSED_SUFFIX = /\s*(?:—\s*\d+s elapsed|\(\d+s\))\s*$/;

const AnalysisProgress: React.FC<AnalysisProgressProps> = ({ stage, message, startTime, percentage }) => {
    const [, tick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => tick(n => n + 1), 1000);
        return () => clearInterval(id);
    }, []);

    // "Taking longer" compares the time in this stage with its own budget; the
    // clock shows the whole run and stops once complete.
    const stageStart = useRef(Date.now());
    const endTime = useRef(0);
    useEffect(() => { stageStart.current = Date.now(); }, [stage]);
    if (stage === 'complete' && !endTime.current) endTime.current = Date.now();
    const elapsed = startTime ? Math.floor(((endTime.current || Date.now()) - startTime) / 1000) : 0;

    const idx = STAGES.findIndex(s => s.key === stage);
    const info = STAGES[idx] || STAGES[2];
    const isTakingLong = info.maxSeconds > 0 && (Date.now() - stageStart.current) / 1000 > info.maxSeconds * 2;
    // WinDBG fell back to local analysis: the message becomes a notice and its step is skipped.
    const fallback = /unavailable/.test(message || '');
    const description = fallback ? info.description
        : stage === 'uploading' && percentage !== undefined ? `Uploading... ${percentage}%` : message || info.description;
    const bar = stage === 'complete' ? 100 : ((idx + (stage === 'uploading' ? (percentage ?? 0) * 0.009 : 0.4)) / 5) * 100;
    const fact = Math.floor(elapsed / 8) % FACTS.length;

    // Assistive technology hears the stage and its message, without the
    // elapsed counter the queued messages end in, which changes on every poll
    // (#311).
    const announced = (message || '').replace(ELAPSED_SUFFIX, '').trim() || info.description;

    return (
        <section className="progress" data-s={stage} aria-label="Analysis progress">
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{info.title}. {announced}</div>
            <div className="progress-bar" aria-hidden="true"><i style={{ width: `${bar}%` }} /></div>

            <div className="progress-head">
                <div>
                    <h3 className="progress-title">{info.title}</h3>
                    <p className="progress-description">{description}</p>
                    {fallback && <p className="progress-notice">{message}</p>}
                </div>
                {startTime && (
                    <div className="progress-time">
                        <span className="progress-cap">Elapsed:</span> <b>{elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`}</b>
                        {stage !== 'complete' && <small className={isTakingLong ? 'warn' : undefined}>{isTakingLong ? 'Taking longer than usual...' : info.typical}</small>}
                    </div>
                )}
            </div>

            <div className="progress-body">
                <div className="progress-mem" aria-hidden="true">
                    <div className="progress-cells"><i style={{ '--p': (percentage ?? 0) / 100 } as React.CSSProperties} /></div>
                </div>
                <div className="progress-side">
                    <svg className="progress-face" viewBox="0 0 120 120" aria-hidden="true">
                        <rect x="4" y="4" width="112" height="112" rx="26" />
                        <circle cx="42" cy="48" r="8" /><circle cx="78" cy="48" r="8" />
                        <path d="M40 88Q60 66 80 88" />
                    </svg>
                    <ol className="progress-steps">
                        {STAGES.slice(0, 5).map((s, i) => (
                            <li key={s.key} className="progress-step" data-state={fallback && i === 2 ? 'skip' : stage === 'complete' || i < idx ? 'done' : i === idx ? 'active' : 'pending'}>
                                <span className="progress-node" />
                                <span className="progress-label">{s.label}</span>
                            </li>
                        ))}
                    </ol>
                </div>
            </div>

            <div className="progress-fact">
                <b>Did you know?</b>
                <p key={fact}>{FACTS[fact]}</p>
            </div>
        </section>
    );
};

export default AnalysisProgress;
