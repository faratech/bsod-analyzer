import React from 'react';
import { DumpFile } from '../types';
import AnalysisReportCard from './AnalysisReportCard';

interface AnalysisResultsProps {
    title?: string;
    dumpFiles: DumpFile[];
    onUpdateAdvancedAnalysis: (fileId: string, tool: string, result: string) => void;
    onRetry?: (fileId: string) => void;
    className?: string;
    showAds?: boolean;
    AdComponent?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}

const AnalysisResults: React.FC<AnalysisResultsProps> = ({
    title = "Analysis Results",
    dumpFiles,
    onUpdateAdvancedAnalysis,
    onRetry,
    className = '',
    showAds = false,
    AdComponent
}) => {
    if (dumpFiles.length === 0) {
        return null;
    }

    return (
        <section id="analysis-results" className={className} style={{ marginTop: '2rem', marginBottom: '4rem' }}>
            <h2 style={{ textAlign: 'center', marginBottom: '2rem' }}>{title}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem'}}>
                {dumpFiles.map((dumpFile, index) => (
                    <React.Fragment key={dumpFile.id}>
                        <AnalysisReportCard
                            dumpFile={dumpFile}
                            onUpdateAdvancedAnalysis={onUpdateAdvancedAnalysis}
                            onRetry={onRetry ? () => onRetry(dumpFile.id) : undefined}
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
};

export default AnalysisResults;