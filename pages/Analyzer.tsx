import React, { useState, useCallback, useEffect } from 'react';
import { DumpFile, FileStatus } from '../types';
import FileUploader from '../components/FileUploader';
import FilePreview from '../components/FilePreview';
import ErrorAlert from '../components/ErrorAlert';
import AnalysisResults from '../components/AnalysisResults';
import AnalysisProgress from '../components/AnalysisProgress';
import { AnalyzeIcon } from '../components/Icons';
import SEO from '../components/SEO';
import { useAnalytics } from '../hooks/useAnalytics';
import { useFileProcessor } from '../hooks/useFileProcessor';
import { useAnalysis } from '../hooks/useAnalysis';
import { InArticleAd, VerticalAd, InFeedAd } from '../components/AdSense';
import { DisplayAdSafe, SafeAd } from '../components/AdSenseWithSizeCheck';
import { initializeSession, startSessionRefresh, stopSessionRefresh } from '../utils/sessionManager';

const Analyzer: React.FC = () => {
    const { trackFileUpload, trackAnalysisStart, trackAnalysisComplete } = useAnalytics();
    const [dumpFiles, setDumpFiles] = useState<DumpFile[]>([]);
    const [fileProgress, setFileProgress] = useState<Record<string, number>>({});
    const { processFiles, addFilesToState, error: fileError } = useFileProcessor();
    const { isAnalyzing, progress, error: analysisError, analyzeFiles, updateAdvancedAnalysis } = useAnalysis();
    
    const error = fileError || analysisError;
    const [sessionReady, setSessionReady] = useState(false);

    // Initialize session on component mount
    useEffect(() => {
        initializeSession().then(success => {
            setSessionReady(success);
            if (success) {
                startSessionRefresh();
            } else {
                console.error('Failed to initialize session for analyzer');
            }
        });

        // Cleanup on unmount
        return () => {
            stopSessionRefresh();
        };
    }, []);

    const handleFilesAdded = useCallback(async (acceptedFiles: File[]) => {
        // Set initial progress for new files
        const progressInit: Record<string, number> = {};
        acceptedFiles.forEach((file) => {
            progressInit[file.name] = 0;
        });
        setFileProgress(prev => ({ ...prev, ...progressInit }));
        
        // Simulate processing progress
        acceptedFiles.forEach((file) => {
            const interval = setInterval(() => {
                setFileProgress(prev => {
                    const newProgress = { ...prev };
                    if (newProgress[file.name] < 100) {
                        newProgress[file.name] = Math.min(newProgress[file.name] + 10, 100);
                    } else {
                        clearInterval(interval);
                    }
                    return newProgress;
                });
            }, 200);
        });
        
        const newDumpFiles = await processFiles(acceptedFiles, trackFileUpload);
        setDumpFiles(prevFiles => addFilesToState(newDumpFiles, prevFiles));
    }, [processFiles, addFilesToState, trackFileUpload]);
    
    const handleRemoveFile = useCallback((fileId: string) => {
        setDumpFiles(prevFiles => prevFiles.filter(file => file.id !== fileId));
        // Remove from progress tracking
        const fileName = dumpFiles.find(f => f.id === fileId)?.file.name;
        if (fileName) {
            setFileProgress(prev => {
                const newProgress = { ...prev };
                delete newProgress[fileName];
                return newProgress;
            });
        }
    }, [dumpFiles]);

    const handleAnalyze = async () => {
        // Show under development notification
        const confirmAnalyze = window.confirm(
            "⚠️ Under Development Notice\n\n" +
            "This BSOD analyzer is currently in beta testing. While it provides helpful insights, " +
            "please note that:\n\n" +
            "• Analysis results may not be 100% accurate\n" +
            "• Some features are still being improved\n" +
            "• For critical systems, consult with IT professionals\n\n" +
            "Do you want to proceed with the analysis?"
        );
        
        if (!confirmAnalyze) {
            return;
        }
        
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
                        <FileUploader onFilesAdded={handleFilesAdded} currentFileCount={dumpFiles.length} />
                        
                        {dumpFiles.length > 0 && (
                            <>
                                <div className="file-preview-list" style={{ marginTop: '1.5rem', marginBottom: '1.5rem' }}>
                                    {dumpFiles.filter(df => df.status === FileStatus.PENDING).map(dumpFile => (
                                        <FilePreview
                                            key={dumpFile.id}
                                            file={dumpFile.file}
                                            progress={fileProgress[dumpFile.file.name] || 100}
                                            onRemove={() => handleRemoveFile(dumpFile.id)}
                                            status={fileProgress[dumpFile.file.name] < 100 ? 'processing' : 'completed'}
                                        />
                                    ))}
                                </div>
                                
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
                            </>
                        )}
                    </div>
                </div>
            </section>
            
            {/* Ad after upload section */}
            <DisplayAdSafe 
                className="ad-header"
                style={{ minHeight: '90px' }}
                minWidth={250}
            />
            
            <div className="container">
                {error && <ErrorAlert error={error} className="mt-2" />}

                {/* Show fancy progress animation during analysis */}
                {isAnalyzing && progress && (
                    <AnalysisProgress
                        stage={progress.stage}
                        message={progress.message}
                        startTime={progress.startTime}
                    />
                )}

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
            <SafeAd
                type="display"
                className="sticky-ad"
                style={{ maxHeight: '90px' }}
                minWidth={320}
            />
        </div>
        </>
    );
};

export default Analyzer;