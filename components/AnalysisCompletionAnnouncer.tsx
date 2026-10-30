import React, { useEffect, useRef, useState } from 'react';

interface AnalysisCompletionAnnouncerProps {
    isAnalyzing: boolean;
    /** Files with a finished report right now; the run's share is the growth over the run. */
    analyzedCount: number;
}

/**
 * Persistent polite live region. The progress card unmounts when a run ends,
 * so completion can't be announced from it: this one stays mounted and speaks
 * once when `isAnalyzing` turns off.
 */
const AnalysisCompletionAnnouncer: React.FC<AnalysisCompletionAnnouncerProps> = ({ isAnalyzing, analyzedCount }) => {
    const [message, setMessage] = useState('');
    const wasAnalyzing = useRef(false);
    const countAtStart = useRef(analyzedCount);

    useEffect(() => {
        if (isAnalyzing && !wasAnalyzing.current) {
            countAtStart.current = analyzedCount;
            setMessage('');
        } else if (!isAnalyzing && wasAnalyzing.current) {
            const finished = analyzedCount - countAtStart.current;
            // A run that produced no report is already reported by the error alert.
            setMessage(finished > 0 ? `Analysis complete for ${finished} ${finished === 1 ? 'file' : 'files'}` : '');
        }
        wasAnalyzing.current = isAnalyzing;
    }, [isAnalyzing, analyzedCount]);

    return (
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {message}
        </div>
    );
};

export default AnalysisCompletionAnnouncer;
