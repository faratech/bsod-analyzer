import React, { useState, useCallback } from 'react';
import { DumpFile, FileStatus } from '../types';
import { analyzeDumpFiles } from '../services/geminiProxy';
import FileUploader from '../components/FileUploader';
import AnalysisReportCard from '../components/AnalysisReportCard';
import { AnalyzeIcon } from '../components/Icons';
import SEO from '../components/SEO';
import { useAnalytics } from '../hooks/useAnalytics';
import { DisplayAd, InArticleAd, StickyAd, VerticalAd, InFeedAd } from '../components/AdSense';

declare const JSZip: any;

const Analyzer: React.FC = () => {
    const { trackFileUpload, trackAnalysisStart, trackAnalysisComplete } = useAnalytics();
    const [dumpFiles, setDumpFiles] = useState<DumpFile[]>([]);
    const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    
    const DUMP_TYPE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

    const handleFilesAdded = useCallback(async (acceptedFiles: File[]) => {
        setError(null);
        const newDumpFiles: DumpFile[] = [];

        for (const file of acceptedFiles) {
            const processFile = (f: File) => {
                const dumpType = f.size > DUMP_TYPE_THRESHOLD ? 'kernel' : 'minidump';
                newDumpFiles.push({
                    id: `${f.name}-${Date.now()}`,
                    file: f,
                    status: FileStatus.PENDING,
                    dumpType: dumpType,
                });
                // Track file upload
                trackFileUpload(dumpType, f.size);
            }

            if (file.name.toLowerCase().endsWith('.zip')) {
                try {
                    const zip = await JSZip.loadAsync(file);
                    for (const relativePath in zip.files) {
                        if (relativePath.toLowerCase().endsWith('.dmp')) {
                            const zipEntry = zip.files[relativePath];
                            if (!zipEntry.dir) {
                                const blob = await zipEntry.async('blob');
                                const dmpFile = new File([blob], zipEntry.name, { type: 'application/octet-stream' });
                                processFile(dmpFile);
                            }
                        }
                    }
                } catch (e) {
                    console.error("Error processing zip file:", e);
                    setError(`Error processing ZIP file: ${file.name}`);
                }
            } else if (file.name.toLowerCase().endsWith('.dmp')) {
                processFile(file);
            }
        }
        
        setDumpFiles(prevFiles => {
            const existingFileNames = new Set(prevFiles.map(df => df.file.name));
            const uniqueNewFiles = newDumpFiles.filter(df => !existingFileNames.has(df.file.name));
            return [...prevFiles, ...uniqueNewFiles];
        });

    }, []);

    const handleAnalyze = async () => {
        setIsAnalyzing(true);
        setError(null);

        const filesToAnalyze = dumpFiles.filter(df => df.status === FileStatus.PENDING);
        
        if (filesToAnalyze.length === 0) {
            setIsAnalyzing(false);
            return;
        }

        setDumpFiles(prevFiles =>
            prevFiles.map(df => 
                filesToAnalyze.some(fta => fta.id === df.id) 
                    ? { ...df, status: FileStatus.ANALYZING } 
                    : df
            )
        );

        try {
            // Track analysis start for each file
            filesToAnalyze.forEach(file => {
                trackAnalysisStart(file.dumpType);
            });

            const analysisResults = await analyzeDumpFiles(filesToAnalyze);

            setDumpFiles(prevFiles =>
                prevFiles.map(df => {
                    const result = analysisResults.find(r => r.id === df.id);
                    if (result) {
                        if (result.report) {
                            // Track successful analysis
                            trackAnalysisComplete(true, df.dumpType);
                            return { ...df, status: FileStatus.ANALYZED, report: result.report };
                        }
                        // Track failed analysis
                        trackAnalysisComplete(false, df.dumpType);
                        return { ...df, status: FileStatus.ERROR, error: result.error || 'Unknown analysis error' };
                    }
                    return df;
                })
            );
        } catch (e) {
            console.error("Analysis failed:", e);
            setError('A critical error occurred during analysis.');
            setDumpFiles(prevFiles =>
                prevFiles.map(df =>
                    df.status === FileStatus.ANALYZING ? { ...df, status: FileStatus.ERROR, error: 'Analysis failed' } : df
                )
            );
        } finally {
            setIsAnalyzing(false);
        }
    };
    
    const handleUpdateAdvancedAnalysis = (fileId: string, tool: string, result: string) => {
        setDumpFiles(prevFiles =>
            prevFiles.map(df => {
                if (df.id === fileId && df.report) {
                    const newAdvancedAnalyses = [
                        ...(df.report.advancedAnalyses || []),
                        { tool, result }
                    ];
                    return {
                        ...df,
                        report: {
                            ...df.report,
                            advancedAnalyses: newAdvancedAnalyses
                        }
                    };
                }
                return df;
            })
        );
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
                {error && (
                    <div className="card status-error fade-in" style={{ padding: '1.5rem', color: 'var(--text-primary)', marginTop: '2rem'}} role="alert">
                        <strong>Error: </strong>
                        <span>{error}</span>
                    </div>
                )}

                {dumpFiles.length > 0 && (
                    <section id="analysis-results" style={{ marginTop: '2rem', marginBottom: '4rem' }}>
                        <h2 style={{ textAlign: 'center', marginBottom: '2rem' }}>Analysis Results</h2>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem'}}>
                            {dumpFiles.map((dumpFile, index) => (
                                <React.Fragment key={dumpFile.id}>
                                    <AnalysisReportCard
                                        dumpFile={dumpFile}
                                        onUpdateAdvancedAnalysis={handleUpdateAdvancedAnalysis}
                                        style={{ animationDelay: `${index * 100}ms` }}
                                    />
                                    {/* Add an in-feed ad after every 2 analysis results */}
                                    {(index + 1) % 2 === 0 && index !== dumpFiles.length - 1 && (
                                        <InFeedAd 
                                            className="ad-inline"
                                            style={{ margin: '1rem 0' }}
                                        />
                                    )}
                                </React.Fragment>
                            ))}
                        </div>
                        
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
                    </section>
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