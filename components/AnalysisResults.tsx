import React, { memo, useEffect, useRef, useState } from 'react';
import { DumpFile, FileStatus } from '../types';
import AnalysisReportCard from './AnalysisReportCard';

interface AnalysisResultsProps {
    title?: string;
    dumpFiles: DumpFile[];
    onRetry?: (fileId: string) => void;
    /** Remove one finished or failed result (issue #370). */
    onRemove?: (fileId: string) => void;
    /** Remove every finished or failed result. */
    onClearFinished?: () => void;
    /** Gets focus when Remove or Clear leaves no result (the section is gone); give it tabIndex -1. */
    emptyFocusRef?: React.RefObject<HTMLElement | null>;
    /** Retry needs the data-use terms like Analyze: shown disabled while they are unchecked. */
    retryDisabled?: boolean;
    className?: string;
    showAds?: boolean;
    AdComponent?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}

const AnalysisResults: React.FC<AnalysisResultsProps> = memo(({
    title = "Analysis Results",
    dumpFiles,
    onRetry,
    onRemove,
    onClearFinished,
    emptyFocusRef,
    retryDisabled = false,
    className = '',
    showAds = false,
    AdComponent
}) => {
    // Remove and Clear unmount the button that has focus (issue #379): say
    // what happened in a live region that outlives the cards and the section,
    // and move focus to the next report's toggle, else the previous one, else
    // the results heading, else emptyFocusRef once no result is left.
    const [announcement, setAnnouncement] = useState('');
    const focusAfterUpdate = useRef<string | null>(null);
    const sectionRef = useRef<HTMLElement>(null);
    const headingRef = useRef<HTMLHeadingElement>(null);

    useEffect(() => {
        const target = focusAfterUpdate.current;
        if (target === null) return;
        focusAfterUpdate.current = null;
        const toggle = [...(sectionRef.current?.querySelectorAll<HTMLElement>('.result-toggle[aria-controls]') ?? [])]
            .find(el => el.getAttribute('aria-controls') === `report-content-${target}`);
        (toggle ?? headingRef.current ?? emptyFocusRef?.current)?.focus();
    }, [dumpFiles, emptyFocusRef]);

    const isFinished = (dumpFile: DumpFile) =>
        dumpFile.status === FileStatus.ANALYZED || dumpFile.status === FileStatus.ERROR;
    const hasFinished = dumpFiles.some(isFinished);

    const removeOne = (index: number) => {
        const dumpFile = dumpFiles[index];
        focusAfterUpdate.current = (dumpFiles[index + 1] ?? dumpFiles[index - 1])?.id ?? '';
        setAnnouncement(`Report for ${dumpFile.displayName || dumpFile.file.name} removed`);
        onRemove?.(dumpFile.id);
    };
    const clearFinished = () => {
        const count = dumpFiles.filter(isFinished).length;
        focusAfterUpdate.current = '';
        setAnnouncement(`Cleared ${count} finished ${count === 1 ? 'report' : 'reports'}`);
        onClearFinished?.();
    };

    const liveRegion = (
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {announcement}
        </div>
    );
    if (dumpFiles.length === 0) {
        return liveRegion;
    }

    return (
        <>
        {liveRegion}
        <section id="analysis-results" ref={sectionRef} className={className} style={{ marginTop: '2rem', marginBottom: '4rem' }}>
            <h2 ref={headingRef} tabIndex={-1} style={{ textAlign: 'center', marginBottom: onClearFinished && hasFinished ? '0.75rem' : '2rem' }}>{title}</h2>
            {onClearFinished && hasFinished && (
                <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                    <button type="button" className="btn btn-secondary" onClick={clearFinished}>
                        Clear finished results
                    </button>
                </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem'}}>
                {dumpFiles.map((dumpFile, index) => (
                    <React.Fragment key={dumpFile.id}>
                        <AnalysisReportCard
                            dumpFile={dumpFile}
                            onRetry={onRetry ? () => onRetry(dumpFile.id) : undefined}
                            onRemove={onRemove && isFinished(dumpFile) ? () => removeOne(index) : undefined}
                            retryDisabled={retryDisabled}
                            style={{ animationDelay: `${index * 100}ms` }}
                        />
                        {/* Add an ad after every 2 analysis results */}
                        {showAds && AdComponent && (index + 1) % 2 === 0 && index !== dumpFiles.length - 1 && (
                            <AdComponent 
                                className="ad-inline"
                                style={{ margin: '1rem 0' }}
                            />
                        )}
                    </React.Fragment>
                ))}
            </div>
        </section>
        </>
    );
});

AnalysisResults.displayName = 'AnalysisResults';

export default AnalysisResults;
