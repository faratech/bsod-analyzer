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

// The first five rows are the steps beside the grid (cmd is what the active step shows);
// maxSeconds is a stage's own budget for the "taking longer" note, think is what the
// mascot thinks, log is the typing log in the corner of the grid.
const STAGES = [
    { key: 'uploading', title: 'Uploading Dump File', description: 'Securely transferring your crash dump to the analysis server...', label: 'Upload', cmd: 'sending dump...', typical: 'typically 5–15 seconds', maxSeconds: 15,
        think: ['heave ho!', 'shipping your dump...', 'steady... steady...'], log: ['sending dump.dmp', 'to the analysis server', 'keep this tab open'] },
    { key: 'queued', title: 'Queued for Analysis', description: 'Your file is in the queue and will be processed shortly...', label: 'Queue', cmd: 'waiting for a debugger', typical: 'usually under a minute', maxSeconds: 60,
        think: ['any minute now...', 'tap tap tap...', 'is it my turn?'], log: ['waiting for a free debugger', 'you are in the queue', 'this page updates itself'] },
    { key: 'processing', title: 'WinDBG Analysis in Progress', description: 'Running professional debugging commands on your crash dump...', label: 'WinDBG', cmd: 'kd> !analyze -v', typical: 'usually 30–90 seconds', maxSeconds: 90,
        think: ["let's see what broke", 'kd> hmm...', 'who touched my kernel?'], log: ['kd> !analyze -v', 'kd> lm', 'kd> k'] },
    { key: 'downloading', title: 'Downloading Results', description: 'Retrieving the detailed analysis from WinDBG...', label: 'Fetch', cmd: 'fetching output', typical: 'a few seconds', maxSeconds: 10,
        think: ['catch it!', 'nom nom bytes', 'one more block...'], log: ['fetching analysis output', 'receiving the results', 'nearly ready'] },
    { key: 'analyzing', title: 'AI Analysis', description: 'Our AI is interpreting the crash data for you...', label: 'AI', cmd: 'explaining cause', typical: 'usually 10–30 seconds', maxSeconds: 30,
        think: ['thinking...', 'hmm... hmm...', 'connecting the dots'], log: ['reading the stack and modules', 'weighing likely causes', 'drafting fixes'] },
    { key: 'complete', title: 'Analysis Complete', description: 'Your crash analysis is ready!', label: '', cmd: '', typical: '', maxSeconds: 0,
        think: ['got it!', "report's ready", 'high five!'], log: ['analysis complete', 'report ready', 'scroll for the details'] },
];

// Every 8 s of the run the mascot does something else (0 = the pose of the stage); each antic has a line.
const ANTICS = [0, 1, 0, 2, 3, 0, 4, 5, 0, 6, 7, 0, 8];
const ANTIC_SAYS = ['', 'hi there!', 'just looking around...', '*yaaawn*', 'look, no hands!', 'la la la', 'ooh, what is that?', 'wheee!', 'still got it'];
const SLOW = ['still working...', 'this one is a big one', 'hang in there!'];

// Drops a trailing elapsed counter: `— 40s elapsed` or `(40s)`.
const ELAPSED_SUFFIX = /\s*(?:—\s*\d+s elapsed|\(\d+s\))\s*$/;

// An original blue-screen gremlin; styles.css gives each stage and antic its own pose.
const GREMLIN = (
    <svg className="gr" viewBox="-14 -22 168 176">
        <rect className="gr-limb gr-al" x="2" y="68" width="20" height="10" rx="5" />
        <rect className="gr-limb gr-ar" x="118" y="68" width="20" height="10" rx="5" />
        <rect className="gr-limb gr-fl" x="42" y="108" width="22" height="14" rx="7" />
        <rect className="gr-limb gr-fr" x="76" y="108" width="22" height="14" rx="7" />
        <g className="gr-top">
            <line className="gr-stem" x1="70" y1="26" x2="70" y2="12" />
            <circle className="gr-bulb" cx="70" cy="9" r="5.5" />
            <circle className="gr-prop gr-gear" cx="108" cy="12" r="7.5" />
            <path className="gr-ear" d="M26 38 L10 16 L40 28Z" />
            <path className="gr-ear" d="M114 38 L130 16 L100 28Z" />
            <rect className="gr-head" x="16" y="24" width="108" height="88" rx="26" />
            <rect className="gr-screen" x="27" y="35" width="86" height="64" rx="16" />
            <g className="gr-eyes"><circle className="gr-eye" cx="53" cy="62" r="7.5" /><circle className="gr-eye" cx="87" cy="62" r="7.5" /></g>
            <path className="gr-mouth" d="M57 86 Q70 75 83 86" />
            <ellipse className="gr-yawn" cx="70" cy="85" rx="8" ry="9" />
            <path className="gr-prop gr-sweat" d="M112 40 q-6 9 0 12 q6 -3 0 -12z" />
        </g>
        <g className="gr-prop gr-mag"><circle cx="118" cy="86" r="9" /><line x1="124.5" y1="92.5" x2="133" y2="101" /></g>
        <rect className="gr-prop gr-crate" x="-12" y="62" width="14" height="14" rx="3" />
        <rect className="gr-prop gr-blk" x="36" y="-2" width="14" height="14" rx="3" />
        <rect className="gr-prop gr-blk gr-blk2" x="92" y="-2" width="14" height="14" rx="3" />
        {[1, 2, 3].map(n => <rect key={n} className={`gr-prop gr-jug gr-jug${n}`} x="63" y="-12" width="10" height="10" rx="2" />)}
        {[[98, 20], [108, 10], [118, 0]].map(([x, y], n) => <text key={n} className={`gr-prop gr-z gr-z${n + 1}`} x={x} y={y}>z</text>)}
        <text className="gr-prop gr-q" x="6" y="12">?</text>
        <text className="gr-prop gr-bang" x="8" y="12">!</text>
        <text className="gr-prop gr-note" x="112" y="6">♪</text>
    </svg>
);

// Twelve particles; the stage decides what they do.
const FX = Array.from({ length: 12 }, (_, i) => (
    <b key={i} style={{ left: `${6 + ((i * 37) % 88)}%`, top: `${12 + ((i * 53) % 70)}%`, animationDelay: `-${((i * 0.61) % 6.5).toFixed(2)}s` }} />
));

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
    const done = stage === 'complete';
    const isTakingLong = info.maxSeconds > 0 && (Date.now() - stageStart.current) / 1000 > info.maxSeconds * 2;
    // WinDBG fell back to local analysis: the message becomes a notice and its step is skipped.
    const fallback = /unavailable/.test(message || '');
    const description = fallback ? info.description
        : stage === 'uploading' && percentage !== undefined ? `Uploading... ${percentage}%` : message || info.description;
    const bar = done ? 100 : ((idx + (stage === 'uploading' ? (percentage ?? 0) * 0.009 : 0.4)) / 5) * 100;
    const fact = Math.floor(elapsed / 8) % FACTS.length;
    const antic = done ? 0 : ANTICS[Math.floor(elapsed / 8) % ANTICS.length];
    const thoughts = isTakingLong ? SLOW : antic ? [ANTIC_SAYS[antic]] : info.think;

    // Assistive technology hears the stage and its message, without the
    // elapsed counter the queued messages end in, which changes on every poll
    // (#311).
    const announced = (message || '').replace(ELAPSED_SUFFIX, '').trim() || info.description;

    return (
        <section className="progress" data-s={stage} data-slow={isTakingLong || undefined} aria-label="Analysis progress">
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{info.title}. {announced}</div>
            <div className="progress-bar" aria-hidden="true"><i style={{ width: `${bar}%` }} /></div>
            <i key={stage} className="progress-flash" aria-hidden="true" />

            <div className="progress-head">
                <div>
                    <h3 className="progress-title">{info.title}</h3>
                    <p className="progress-description">{description}</p>
                    {fallback && <p className="progress-notice">{message}</p>}
                </div>
                {startTime && (
                    <div className="progress-time">
                        <span className="progress-cap">Elapsed:</span> <b>{elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`}</b>
                        {!done && <small className={isTakingLong ? 'warn' : undefined}>{isTakingLong ? 'Taking longer than usual...' : info.typical}</small>}
                    </div>
                )}
            </div>

            <div className="progress-body">
                <div className="progress-mem" aria-hidden="true">
                    <div className="progress-cells"><i style={{ '--p': (percentage ?? 0) / 100 } as React.CSSProperties} /></div>
                    <div className="progress-fx">{FX}</div>
                    <div className="progress-log">{info.log.map(line => <span key={line}>{line}</span>)}</div>
                </div>
                <div className="progress-side">
                    <div className="progress-fw" aria-hidden="true" data-antic={antic}>
                        {GREMLIN}
                        <div className="progress-think" key={`${antic}${isTakingLong}`}>{thoughts.map(t => <span key={t}>{t}</span>)}</div>
                    </div>
                    <ol className="progress-steps">
                        {STAGES.slice(0, 5).map((s, i) => (
                            <li key={s.key} className="progress-step" data-state={fallback && i === 2 ? 'skip' : done || i < idx ? 'done' : i === idx ? 'active' : 'pending'}>
                                <span className="progress-node" />
                                <span className="progress-txt">
                                    <span className="progress-label">{s.label}</span>
                                    <span className="progress-cmd">{fallback && i === 2 ? 'skipped · unavailable' : s.cmd}</span>
                                </span>
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
