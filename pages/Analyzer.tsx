import React, { useState, useCallback } from 'react';
import { DumpFile, FileStatus } from '../types';
import FileUploader from '../components/FileUploader';
import ErrorAlert from '../components/ErrorAlert';
import AnalysisResults from '../components/AnalysisResults';
import { AnalyzeIcon } from '../components/Icons';
import SEO from '../components/SEO';
import { useAnalytics } from '../hooks/useAnalytics';
import { useFileProcessor } from '../hooks/useFileProcessor';
import { useAnalysis } from '../hooks/useAnalysis';
import { DisplayAd, InArticleAd, StickyAd, VerticalAd, InFeedAd } from '../components/AdSense';

const Analyzer: React.FC = () => {
    const { trackFileUpload, trackAnalysisStart, trackAnalysisComplete } = useAnalytics();
    const [dumpFiles, setDumpFiles] = useState<DumpFile[]>([]);
    const { processFiles, addFilesToState, error: fileError } = useFileProcessor();
    const { isAnalyzing, error: analysisError, analyzeFiles, updateAdvancedAnalysis } = useAnalysis();
    
    const error = fileError || analysisError;

    const handleFilesAdded = useCallback(async (acceptedFiles: File[]) => {
        const newDumpFiles = await processFiles(acceptedFiles, trackFileUpload);
        setDumpFiles(prevFiles => addFilesToState(newDumpFiles, prevFiles));
    }, [processFiles, addFilesToState, trackFileUpload]);

    const handleAnalyze = async () => {
        await analyzeFiles(dumpFiles, setDumpFiles, {
            trackAnalysisStart,
            trackAnalysisComplete
        });
    };
    
    const handleUpdateAdvancedAnalysis = (fileId: string, tool: string, result: string) => {
        updateAdvancedAnalysis(fileId, tool, result, dumpFiles, setDumpFiles);
    };

    const pendingFilesCount = dumpFiles.filter(df => df.status === FileStatus.PENDING).length;

    return (
        <>
            <SEO 
                title="BSOD Dump File Analyzer - Upload & Analyze Crash Dumps"
                description="Upload your Windows crash dump files (.dmp) for instant AI-powered analysis. Support for minidumps, kernel dumps, and complete memory dumps. Get detailed crash analysis in seconds."
                keywords="upload dump file, analyze BSOD, crash dump analyzer, minidump upload, kernel dump analysis, Windows debugging tool"
                canonicalUrl="https://bsod.windowsforum.com/analyzer"
            />
            <main>
                <section className="analyzer-hero">
                <div className="container">
                    <div className="analyzer-header">
                        <h1>BSOD Dump Analyzer</h1>
                        <p>Upload your Windows crash dump files for instant AI-powered analysis</p>
                    </div>
                    
                    <div className="analyzer-upload-section">
                        <FileUploader onFilesAdded={handleFilesAdded} />
                        
                        {dumpFiles.length > 0 && (
                            <div className="analyzer-controls">
                                <button
                                    onClick={handleAnalyze}
                                    disabled={isAnalyzing || pendingFilesCount === 0}
                                    className="btn btn-primary"
                                >
                                    <AnalyzeIcon />
                                    <span style={{ marginLeft: '0.5rem' }}>
                                        {isAnalyzing ? 'Analyzing...' : `Analyze ${pendingFilesCount} New File(s)`}
                                    </span>
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </section>
            
            {/* Ad after upload section */}
            <DisplayAd 
                className="ad-header"
                style={{ minHeight: '90px' }}
            />
            
            <div className="container">
                {error && <ErrorAlert error={error} className="mt-2" />}

                <AnalysisResults
                    dumpFiles={dumpFiles}
                    onUpdateAdvancedAnalysis={handleUpdateAdvancedAnalysis}
                    showAds={true}
                    AdComponent={InFeedAd}
                />
                
                {/* Vertical ad on desktop, shown alongside results */}
                {dumpFiles.length > 0 && (
                    <aside className="desktop-only" style={{
                        position: 'absolute',
                        right: '-320px',
                        top: '60px',
                        width: '300px'
                    }}>
                        <VerticalAd 
                            className="ad-sidebar"
                            style={{ position: 'sticky', top: '80px' }}
                        />
                    </aside>
                )}
            </div>
        </main>
        
        {/* Sticky ad for mobile - only shows on mobile devices */}
        <div className="mobile-only">
            <StickyAd 
                style={{ maxHeight: '90px' }}
            />
        </div>
        </>
    );
};

export default Analyzer;