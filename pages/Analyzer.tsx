declare const __BUILD_VERSION__: string;
import React, { useState, useCallback, useEffect } from 'react';
import { DumpFile, FileStatus } from '../types';
import FileUploader from '../components/FileUploader';
import FilePreview from '../components/FilePreview';
import ErrorAlert from '../components/ErrorAlert';
import AnalysisResults from '../components/AnalysisResults';
import AnalysisProgress from '../components/AnalysisProgress';
import { AnalyzeIcon } from '../components/Icons';
import SEO from '../components/SEO';
import StructuredData from '../components/StructuredData';
import { SITE_URL, IMAGES, IDS } from '../constants/structuredData';
import { useAnalytics } from '../hooks/useAnalytics';
import { useFileProcessor } from '../hooks/useFileProcessor';
import { useAnalysis } from '../hooks/useAnalysis';
import { VerticalAd, InFeedAd } from '../components/AdSense';
import { DisplayAdSafe, SafeAd } from '../components/AdSenseWithSizeCheck';
import { initializeSession, onSessionInvalid, startSessionRefresh, stopSessionRefresh } from '../utils/sessionManager';

const Analyzer: React.FC = () => {
    const { trackFileUpload, trackAnalysisStart, trackAnalysisComplete } = useAnalytics();
    const [dumpFiles, setDumpFiles] = useState<DumpFile[]>([]);
    const [fileProgress, setFileProgress] = useState<Record<string, number>>({});
    const { processFiles, addFilesToState, error: fileError } = useFileProcessor();
    const { isAnalyzing, progress, error: analysisError, analyzeFiles, retryFile } = useAnalysis();

    const error = fileError || analysisError;
    const [, setSessionReady] = useState(false);

    // Initialize session on component mount
    useEffect(() => {
        initializeSession().then(success => {
            setSessionReady(success);
            if (success) {
                startSessionRefresh();
            }
        });

        return () => {
            stopSessionRefresh();
        };
    }, []);

    // Handle session invalidation to reset file statuses so analysis can be re-run
    useEffect(() => {
        const unsubscribe = onSessionInvalid(() => {
            setDumpFiles(prevFiles =>
                prevFiles.map(df =>
                    df.status === FileStatus.ANALYZING
                        ? { ...df, status: FileStatus.PENDING }
                        : df
                )
            );
        });
        return unsubscribe;
    }, []);

    const handleFilesAdded = useCallback(async (acceptedFiles: File[]) => {
        const newDumpFiles = await processFiles(acceptedFiles, dumpFiles.length, trackFileUpload);
        if (newDumpFiles.length > 0) {
            setFileProgress(prev => {
                const next = { ...prev };
                for (const dumpFile of newDumpFiles) {
                    next[dumpFile.id] = 100;
                }
                return next;
            });
        }
        setDumpFiles(prevFiles => addFilesToState(newDumpFiles, prevFiles));
    }, [processFiles, addFilesToState, trackFileUpload, dumpFiles.length]);
    
    const handleRemoveFile = useCallback((fileId: string) => {
        setDumpFiles(prevFiles => {
            setFileProgress(prev => {
                const next = { ...prev };
                delete next[fileId];
                return next;
            });
            return prevFiles.filter(file => file.id !== fileId);
        });
    }, []);

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
    
    const handleRetry = useCallback((fileId: string) => {
        retryFile(fileId, dumpFiles, setDumpFiles, {
            trackAnalysisStart,
            trackAnalysisComplete
        });
    }, [dumpFiles, retryFile, trackAnalysisStart, trackAnalysisComplete]);

    const pendingFilesCount = dumpFiles.filter(df => df.status === FileStatus.PENDING).length;

    const analyzerStructuredData = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "WebPage",
                "@id": `${SITE_URL}/analyzer#webpage`,
                "url": `${SITE_URL}/analyzer`,
                "name": "BSOD Dump File Analyzer - Upload & Analyze Crash Dumps",
                "isPartOf": { "@id": IDS.website },
                "description": "Upload Windows crash dump files or supported archives for WinDBG-backed AI analysis. Supports minidumps, kernel dumps, and complete memory dumps.",
                "inLanguage": "en-US"
            },
            {
                "@type": "WebApplication",
                "@id": `${SITE_URL}/analyzer#tool`,
                "name": "BSOD Dump Analyzer",
                "url": `${SITE_URL}/analyzer`,
                "applicationCategory": "UtilitiesApplication",
                "operatingSystem": "Web Browser",
                "description": "Upload your Windows crash dump files for instant AI-powered analysis",
                "image": IMAGES.ogImage,
                "offers": {
                    "@type": "Offer",
                    "price": "0",
                    "priceCurrency": "USD"
                },
                "isPartOf": { "@id": IDS.webApplication },
                "featureList": [
                    "Drag-and-drop file upload",
                    "Supports .dmp, .mdmp, .hdmp, .kdmp, .zip, .7z, and .rar files",
                    "WinDBG analysis with AI fallback",
                    "AI-powered result interpretation",
                    "Detailed crash reports"
                ]
            }
        ]
    };

    return (
        <>
            <SEO
                title="BSOD Dump File Analyzer - Upload & Analyze Crash Dumps"
                description="Upload Windows crash dump files or supported archives for WinDBG-backed AI analysis. Supports minidumps, kernel dumps, and complete memory dumps."
                keywords="upload dump file, analyze BSOD, crash dump analyzer, minidump upload, kernel dump analysis, Windows debugging tool"
                canonicalUrl="https://bsod.windowsforum.com/analyzer"
            />
            <StructuredData data={analyzerStructuredData} />
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
	                                            displayName={dumpFile.displayName}
	                                            progress={fileProgress[dumpFile.id] ?? 100}
	                                            onRemove={() => handleRemoveFile(dumpFile.id)}
	                                            status={(fileProgress[dumpFile.id] ?? 100) < 100 ? 'processing' : 'completed'}
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
                        percentage={progress.percentage}
                    />
                )}

                <AnalysisResults
                    dumpFiles={dumpFiles.filter(df => df.status !== FileStatus.PENDING)}
                    onRetry={handleRetry}
                    showAds={true}
                    AdComponent={InFeedAd}
                />
                
                {/* Vertical ad on desktop, shown alongside results */}
                {dumpFiles.some(df => df.status !== FileStatus.PENDING) && (
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
        <div style={{ textAlign: 'center', padding: '0.5rem 0', opacity: 0.3, fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>
            {__BUILD_VERSION__}
        </div>
        </>
    );
};

export default Analyzer;
