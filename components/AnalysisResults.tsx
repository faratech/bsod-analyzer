import React, { memo } from 'react';
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
    retryDisabled = false,
    className = '',
    showAds = false,
    AdComponent
}) => {
    if (dumpFiles.length === 0) {
        return null;
    }
    const isFinished = (dumpFile: DumpFile) =>
        dumpFile.status === FileStatus.ANALYZED || dumpFile.status === FileStatus.ERROR;
    const hasFinished = dumpFiles.some(isFinished);

    return (
        <section id="analysis-results" className={className} style={{ marginTop: '2rem', marginBottom: '4rem' }}>
            <h2 style={{ textAlign: 'center', marginBottom: onClearFinished && hasFinished ? '0.75rem' : '2rem' }}>{title}</h2>
            {onClearFinished && hasFinished && (
                <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                    <button type="button" className="btn btn-secondary" onClick={onClearFinished}>
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
                            onRemove={onRemove && isFinished(dumpFile) ? () => onRemove(dumpFile.id) : undefined}
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
    );
});

AnalysisResults.displayName = 'AnalysisResults';

export default AnalysisResults;
