import React, { useState, useEffect } from 'react';

interface AnalysisProgressProps {
    stage: 'uploading' | 'queued' | 'processing' | 'downloading' | 'analyzing' | 'complete';
    message?: string;
    startTime?: number;
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

const AnalysisProgress: React.FC<AnalysisProgressProps> = ({ stage, message, startTime }) => {
    const [currentFact, setCurrentFact] = useState(0);
    const [elapsedTime, setElapsedTime] = useState(0);
    const [dots, setDots] = useState('');

    // Rotate fun facts every 8 seconds
    useEffect(() => {
        const interval = setInterval(() => {
            setCurrentFact(prev => (prev + 1) % funFacts.length);
        }, 8000);
        return () => clearInterval(interval);
    }, []);

    // Update elapsed time
    useEffect(() => {
        if (!startTime) return;
        const interval = setInterval(() => {
            setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
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

    return (
        <div className="analysis-progress-container">
            <div className="analysis-progress-card">
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
                <h3 className="progress-title">{info.title}{dots}</h3>
                <p className="progress-description">{message || info.description}</p>

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

                {/* Elapsed time */}
                {startTime && (
                    <div className="progress-time">
                        <span className="time-icon">⏱️</span>
                        <span>Elapsed: {formatTime(elapsedTime)}</span>
                    </div>
                )}

                {/* Animated loading bar */}
                <div className="progress-bar-container">
                    <div className="progress-bar-track">
                        <div className="progress-bar-fill"></div>
                        <div className="progress-bar-shimmer"></div>
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
