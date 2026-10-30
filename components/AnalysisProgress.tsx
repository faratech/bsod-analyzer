import React, { useState, useEffect, useRef } from 'react';

interface AnalysisProgressProps {
    stage: 'uploading' | 'queued' | 'processing' | 'downloading' | 'analyzing' | 'complete';
    message?: string;
    startTime?: number;
    percentage?: number;
}

const funFacts = [
    "The first Blue Screen of Death appeared in Windows 1.0 in 1985.",
    "BSOD errors are also called 'Stop Errors' or 'Bug Checks' in technical documentation.",
    "Windows 8 introduced a simplified, friendlier BSOD with a sad face emoticon :(",
    "The most common BSOD error is caused by faulty or incompatible drivers.",
    "Microsoft calls the BSOD internally a 'Blue Screen of Doom'.",
    "WinDBG is the same tool Microsoft engineers use to debug Windows itself.",
    "A kernel dump contains a snapshot of all memory at the moment of the crash.",
    "The Windows kernel handles over 400 different types of bug check codes.",
    "IRQL_NOT_LESS_OR_EQUAL is one of the most common BSOD error codes.",
    "Memory dumps can reveal exactly which driver instruction caused the crash.",
    "Professional crash analysis can take hours - our AI does it in seconds!",
    "The :( sad face on modern BSODs is actually a Unicode character.",
    "Windows 11 added a QR code to BSODs for easier troubleshooting.",
    "Minidumps are typically only 256KB but contain crucial crash data.",
    "Full memory dumps can be several gigabytes in size.",
];

const stageInfo: Record<string, { icon: string; title: string; description: string }> = {
    uploading: {
        icon: '📤',
        title: 'Uploading Dump File',
        description: 'Securely transferring your crash dump to the analysis server...'
    },
    queued: {
        icon: '⏳',
        title: 'Queued for Analysis',
        description: 'Your file is in the queue and will be processed shortly...'
    },
    processing: {
        icon: '🔬',
        title: 'WinDBG Analysis in Progress',
        description: 'Running professional debugging commands on your crash dump...'
    },
    downloading: {
        icon: '📥',
        title: 'Downloading Results',
        description: 'Retrieving the detailed analysis from WinDBG...'
    },
    analyzing: {
        icon: '🤖',
        title: 'AI Analysis',
        description: 'Our AI is interpreting the crash data for you...'
    },
    complete: {
        icon: '✅',
        title: 'Analysis Complete',
        description: 'Your crash analysis is ready!'
    }
};

const timeEstimates: Record<string, { typical: string; maxSeconds: number }> = {
    uploading: { typical: 'typically 5\u201315 seconds', maxSeconds: 15 },
    queued: { typical: 'usually under a minute', maxSeconds: 60 },
    processing: { typical: 'usually 30\u201390 seconds', maxSeconds: 90 },
    downloading: { typical: 'a few seconds', maxSeconds: 10 },
    analyzing: { typical: 'usually 10\u201330 seconds', maxSeconds: 30 },
    complete: { typical: '', maxSeconds: 0 },
};

// Drops a trailing elapsed counter: `— 40s elapsed` or `(40s)`.
const ELAPSED_SUFFIX = /\s*(?:\u2014\s*\d+s elapsed|\(\d+s\))\s*$/;
function stableAnnouncement(message: string | undefined): string {
    return (message || '').replace(ELAPSED_SUFFIX, '').trim();
}

const AnalysisProgress: React.FC<AnalysisProgressProps> = ({ stage, message, startTime, percentage }) => {
    const [currentFact, setCurrentFact] = useState(0);
    const [elapsedTime, setElapsedTime] = useState(0);
    // Time spent in the current stage: the "taking longer" check compares it
    // against that stage's own budget (the clock shows the total run time).
    const [stageElapsedTime, setStageElapsedTime] = useState(0);
    const stageStartRef = useRef(Date.now());
    const [dots, setDots] = useState('');

    // Rotate fun facts every 8 seconds
    useEffect(() => {
        const interval = setInterval(() => {
            setCurrentFact(prev => (prev + 1) % funFacts.length);
        }, 8000);
        return () => clearInterval(interval);
    }, []);

    // Restart the per-stage clock whenever the stage changes
    useEffect(() => {
        stageStartRef.current = Date.now();
        setStageElapsedTime(0);
    }, [stage]);

    // Update elapsed time
    useEffect(() => {
        if (!startTime) return;
        const interval = setInterval(() => {
            setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
            setStageElapsedTime(Math.floor((Date.now() - stageStartRef.current) / 1000));
        }, 1000);
        return () => clearInterval(interval);
    }, [startTime]);

    // Animate dots
    useEffect(() => {
        const interval = setInterval(() => {
            setDots(prev => prev.length >= 3 ? '' : prev + '.');
        }, 500);
        return () => clearInterval(interval);
    }, []);

    const formatTime = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    };

    const info = stageInfo[stage] || stageInfo.processing;
    const stageOrder = ['uploading', 'queued', 'processing', 'downloading', 'analyzing', 'complete'];
    const currentStageIndex = stageOrder.indexOf(stage);

    const estimate = timeEstimates[stage];
    const isTakingLong = estimate && estimate.maxSeconds > 0 && stageElapsedTime > estimate.maxSeconds * 2;
    const timeEstimateText = isTakingLong
        ? 'Taking longer than usual...'
        : estimate?.typical || '';

    // For uploading stage, show percentage in the description
    const displayMessage = stage === 'uploading' && percentage !== undefined
        ? `Uploading... ${percentage}%`
        : message || info.description;

    // What assistive technology hears: the stage and its message only. The
    // animated dots, the elapsed timer and the upload percentage tick many
    // times a second/minute and would drown the stage changes. The queued
    // messages also end in an elapsed counter that changes on every poll
    // (windbgService), so it is stripped: the region changes, and is
    // announced, only when the stage or the queue position changes (#311).
    const announcedMessage = stableAnnouncement(message) || info.description;

    return (
        <div className="analysis-progress-container">
            <div className="analysis-progress-card">
                <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                    {info.title}. {announcedMessage}
                </div>
                {/* Animated background */}
                <div className="progress-bg-animation"></div>

                {/* Main icon with pulse animation */}
                <div className="progress-icon-container">
                    <div className="progress-icon-pulse"></div>
                    <div className="progress-icon-pulse delay-1"></div>
                    <div className="progress-icon-pulse delay-2"></div>
                    <span className="progress-icon">{info.icon}</span>
                </div>

                {/* Stage title */}
                <h3 className="progress-title">{info.title}<span aria-hidden="true">{dots}</span></h3>
                <p className="progress-description">{displayMessage}</p>

                {/* Fallback warning */}
                {message && message.includes('unavailable') && (
                    <div style={{
                        backgroundColor: 'rgba(245, 158, 11, 0.15)',
                        border: '1px solid var(--status-warning)',
                        borderRadius: '0.375rem',
                        padding: '0.5rem 0.75rem',
                        marginTop: '0.5rem',
                        fontSize: '0.8rem',
                        color: 'var(--status-warning)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem'
                    }}>
                        <span style={{fontSize: '1rem'}}>&#x26A0;</span>
                        {message}
                    </div>
                )}

                {/* Progress stages indicator */}
                <div className="progress-stages">
                    {stageOrder.slice(0, -1).map((s, index) => (
                        <div key={s} className="progress-stage-item">
                            <div className={`progress-stage-dot ${index < currentStageIndex ? 'completed' : index === currentStageIndex ? 'active' : ''}`}>
                                {index < currentStageIndex && '✓'}
                            </div>
                            {index < stageOrder.length - 2 && (
                                <div className={`progress-stage-line ${index < currentStageIndex ? 'completed' : ''}`}></div>
                            )}
                        </div>
                    ))}
                </div>
                <div className="progress-stage-labels">
                    <span>Upload</span>
                    <span>Queue</span>
                    <span>WinDBG</span>
                    <span>Download</span>
                    <span>AI</span>
                </div>

                {/* Elapsed time with estimate */}
                {startTime && (
                    <div className="progress-time">
                        <span className="time-icon">⏱️</span>
                        <span>
                            Elapsed: {formatTime(elapsedTime)}
                            {timeEstimateText && <span style={{color: 'var(--text-tertiary)', marginLeft: '0.5rem'}}>({timeEstimateText})</span>}
                        </span>
                    </div>
                )}

                {/* Animated loading bar */}
                <div className="progress-bar-container">
                    <div className="progress-bar-track">
                        {stage === 'uploading' && percentage !== undefined ? (
                            <div
                                className="progress-bar-fill"
                                style={{
                                    width: `${percentage}%`,
                                    animation: 'none',
                                    transition: 'width 0.3s ease'
                                }}
                            ></div>
                        ) : (
                            <>
                                <div className="progress-bar-fill"></div>
                                <div className="progress-bar-shimmer"></div>
                            </>
                        )}
                    </div>
                </div>

                {/* Fun fact */}
                <div className="progress-fun-fact">
                    <div className="fun-fact-icon">💡</div>
                    <div className="fun-fact-content">
                        <span className="fun-fact-label">Did you know?</span>
                        <p className="fun-fact-text">{funFacts[currentFact]}</p>
                    </div>
                </div>

                {/* Floating particles animation */}
                <div className="floating-particles">
                    {[...Array(6)].map((_, i) => (
                        <div key={i} className={`particle particle-${i + 1}`}></div>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default AnalysisProgress;
