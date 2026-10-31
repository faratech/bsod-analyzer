declare const __BUILD_VERSION__: string;
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { DumpFile, FileStatus } from '../types';
import FileUploader from '../components/FileUploader';
import DataUseAgreement from '../components/DataUseAgreement';
import FilePreview from '../components/FilePreview';
import ErrorAlert from '../components/ErrorAlert';
import AnalysisResults from '../components/AnalysisResults';
import AnalysisProgress from '../components/AnalysisProgress';
import AnalysisCompletionAnnouncer from '../components/AnalysisCompletionAnnouncer';
import { AnalyzeIcon } from '../components/Icons';
import SEO from '../components/SEO';
import StructuredData from '../components/StructuredData';
import { SITE_URL, IMAGES, IDS } from '../constants/structuredData';
import { useAnalytics } from '../hooks/useAnalytics';
import { useFileProcessor } from '../hooks/useFileProcessor';
import { useAnalysis } from '../hooks/useAnalysis';
import { VerticalAd, InFeedAd } from '../components/AdSense';
import { DisplayAdSafe, SafeAd } from '../components/AdSenseWithSizeCheck';
import { countBatchFiles } from '../utils/fileValidation';
import { getReportFacts } from '../utils/reportFacts';
import { initializeSession, onSessionInvalid, startSessionRefresh, stopSessionRefresh } from '../utils/sessionManager';

const Analyzer: React.FC = () => {
    const { trackFileUpload, trackAnalysisStart, trackAnalysisComplete } = useAnalytics();
    const [dumpFiles, setDumpFiles] = useState<DumpFile[]>([]);
    const [fileProgress, setFileProgress] = useState<Record<string, number>>({});
    const { processFiles, addFilesToState, error: fileError } = useFileProcessor();
    const { isAnalyzing, progress, error: analysisError, analyzeFiles, retryFile } = useAnalysis();

    const error = fileError || analysisError;
    // Data-use terms (checked by default); unchecked disables uploading and analysis.
    const [dataUseAccepted, setDataUseAccepted] = useState(true);
    const [, setSessionReady] = useState(false);
    // Focus target once Remove / Clear finished leaves no result (#379).
    const pageHeadingRef = useRef<HTMLHeadingElement>(null);

    // Initialize session on component mount
    useEffect(() => {
        initializeSession().then(success => {
            setSessionReady(success);
            if (success) {
                startSessionRefresh('analyzer-page');
            }
        });

        return () => {
            // Reference-counted: releasing here no longer kills the timer for
            // AuthProvider/FileUploader owners elsewhere in the app.
            stopSessionRefresh('analyzer-page');
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

    // Files waiting for or under analysis: the 10-file cap is per batch, so
    // finished results stay on the page without blocking new files (#370).
    const batchFileCount = countBatchFiles(dumpFiles);

    const handleFilesAdded = useCallback(async (acceptedFiles: File[]) => {
        const newDumpFiles = await processFiles(acceptedFiles, batchFileCount, trackFileUpload);
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
    }, [processFiles, addFilesToState, trackFileUpload, batchFileCount]);
    
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

    // Drops every analyzed or failed result. Each DumpFile carries its report
    // and any WinDBG result kept for a retry (#331), so dropping it frees them.
    const handleClearFinished = useCallback(() => {
        setDumpFiles(prevFiles => {
            const kept = prevFiles.filter(df => df.status === FileStatus.PENDING || df.status === FileStatus.ANALYZING);
            const keptIds = new Set(kept.map(df => df.id));
            setFileProgress(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => keptIds.has(id))));
            return kept;
        });
    }, []);

    const handleAnalyze = async () => {
        if (!dataUseAccepted) return;
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
        // Same gate as Analyze: without the data-use terms the upload is
        // refused with 428 after consuming rate-limit slots (#236).
        if (!dataUseAccepted) return;
        retryFile(fileId, dumpFiles, setDumpFiles, {
            trackAnalysisStart,
            trackAnalysisComplete
        });
    }, [dataUseAccepted, dumpFiles, retryFile, trackAnalysisStart, trackAnalysisComplete]);

    const pendingFilesCount = dumpFiles.filter(df => df.status === FileStatus.PENDING).length;
    // Stable identity so AnalysisResults' memo is not defeated by a fresh
    // .filter() array on every render (e.g. each upload-progress tick).
    const analyzedFiles = useMemo(
        () => dumpFiles.filter(df => df.status !== FileStatus.PENDING),
        [dumpFiles]
    );

    const analyzedCount = useMemo(
        () => dumpFiles.filter(df => df.status === FileStatus.ANALYZED).length,
        [dumpFiles]
    );

    // During a run the page is one viewport: the uploader hides and the progress
    // card fills the space under the ad. A run that produced a report keeps the
    // finished card for a moment, then it gives way to a summary strip above the
    // results until the visitor asks to analyze another file. `finishing` is set
    // while rendering so the card never unmounts between the run and the hold.
    const [finishing, setFinishing] = useState(false);
    const [summaryOpen, setSummaryOpen] = useState(false);
    const [wasAnalyzing, setWasAnalyzing] = useState(false);
    const analyzedBefore = useRef(0);
    const runIds = useRef<string[]>([]);
    if (isAnalyzing !== wasAnalyzing) {
        setWasAnalyzing(isAnalyzing);
        if (isAnalyzing) {
            analyzedBefore.current = analyzedCount;
            setSummaryOpen(false);
        }
        setFinishing(!isAnalyzing && !error && analyzedCount > analyzedBefore.current);
    }
    useEffect(() => {
        if (!finishing) return;
        const timer = setTimeout(() => { setFinishing(false); setSummaryOpen(true); }, 1600);
        return () => clearTimeout(timer);
    }, [finishing]);

    const live = Boolean((isAnalyzing && progress) || finishing);
    const startTime = useRef(0);
    if (progress) startTime.current = progress.startTime;
    const analyzing = dumpFiles.filter(df => df.status === FileStatus.ANALYZING);
    if (analyzing.length) runIds.current = analyzing.map(df => df.id);
    const fresh = dumpFiles.filter(df => runIds.current.includes(df.id) && df.status === FileStatus.ANALYZED);
    const facts = summaryOpen && fresh.length === 1 ? getReportFacts(fresh[0]) : null;
    const wasLive = useRef(false);
    useEffect(() => {
        if (wasLive.current && !live) {
            const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            (document.getElementById('analysis-summary') ?? document.getElementById('analysis-results'))?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
        }
        wasLive.current = live;
    }, [live]);

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
                <div className={live ? 'analyzer-live' : undefined}>
                <section className="analyzer-hero" hidden={live || summaryOpen}>
                <div className="container">
                    <div className="analyzer-header">
                        <h1 ref={pageHeadingRef} tabIndex={-1}>BSOD Dump Analyzer</h1>
                        <p>Upload your Windows crash dump files for instant AI-powered analysis</p>
                    </div>

                    <div className="analyzer-upload-section">
                        <FileUploader onFilesAdded={handleFilesAdded} currentFileCount={batchFileCount} disabled={!dataUseAccepted} />
                        <DataUseAgreement accepted={dataUseAccepted} onChange={setDataUseAccepted} />
                        
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
                                        disabled={isAnalyzing || pendingFilesCount === 0 || !dataUseAccepted}
                                        title={dataUseAccepted ? undefined : 'Check "Use my crash analysis to improve BSOD AI" to analyze'}
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
                {summaryOpen && !live && (
                    <div id="analysis-summary" className="analyzer-summary" role="region" aria-label="Analysis summary">
                        <span className="progress-node" aria-hidden="true" />
                        <b>Analysis complete</b>
                        {facts?.bugcheck && <span><small>Stop code</small>{facts.bugcheck}</span>}
                        {facts?.culprit && <span><small>Likely cause</small>{facts.culprit}</span>}
                        {fresh.length > 1 && <span>{fresh.length} reports ready</span>}
                        <button className="btn btn-secondary" onClick={() => { setSummaryOpen(false); setTimeout(() => pageHeadingRef.current?.focus(), 0); }}>
                            Analyze another file
                        </button>
                    </div>
                )}
                {error && <ErrorAlert error={error} className="mt-2" />}

                <AnalysisCompletionAnnouncer isAnalyzing={isAnalyzing} analyzedCount={analyzedCount} />

                {live && (
                    <AnalysisProgress
                        stage={progress?.stage ?? 'complete'}
                        message={progress?.message}
                        startTime={startTime.current}
                        percentage={progress?.percentage}
                    />
                )}
            </div>
            </div>

            <div className="container">
                <AnalysisResults
                    dumpFiles={analyzedFiles}
                    onRetry={handleRetry}
                    onRemove={handleRemoveFile}
                    onClearFinished={handleClearFinished}
                    emptyFocusRef={pageHeadingRef}
                    retryDisabled={!dataUseAccepted}
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
        
        {/* Sticky ad for mobile - only shows on mobile devices. Its height
            (--sticky-ad-height) and the page padding it needs come from
            styles.css, shown only once the slot is filled (issue #369). */}
        <div className="mobile-only">
            <SafeAd
                type="display"
                className="sticky-ad"
                minWidth={320}
            />
        </div>
        <div
            suppressHydrationWarning
            style={{ textAlign: 'center', padding: '0.5rem 0', fontSize: '0.65rem', color: 'var(--text-tertiary)' }}
        >
            {__BUILD_VERSION__}
        </div>
        </>
    );
};

export default Analyzer;
