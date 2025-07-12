import React, { useState, useCallback } from 'react';
import { DumpFile, FileStatus } from './types';
import { analyzeDumpFiles } from './services/geminiProxy';
import FileUploader from './components/FileUploader';
import AnalysisReportCard from './components/AnalysisReportCard';
import { AnalyzeIcon, UploadFeatureIcon, AnalyzeFeatureIcon, ResolveFeatureIcon, AnimatedLogoIcon } from './components/Icons';

declare const JSZip: any;

const Logo = () => (
    <div className="logo">
        <div className="logo-icon">
             <AnimatedLogoIcon />
        </div>
        <div>
            <div className="logo-text">BSOD AI Analyzer</div>
            <div className="logo-subtitle">By WindowsForum</div>
        </div>
    </div>
);

const App: React.FC = () => {
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
            const analysisResults = await analyzeDumpFiles(filesToAnalyze);

            setDumpFiles(prevFiles =>
                prevFiles.map(df => {
                    const result = analysisResults.find(r => r.id === df.id);
                    if (result) {
                        if (result.report) {
                            return { ...df, status: FileStatus.ANALYZED, report: result.report };
                        }
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
            <header className="header">
                <div className="container">
                    <div className="header-content">
                        <Logo />
                         {dumpFiles.length > 0 && (
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
                        )}
                    </div>
                </div>
            </header>

            <main>
                <section className="hero">
                    <div className="hero-background">
                        <div className="hero-grid"></div>
                    </div>
                    <div className="container">
                        <div className="hero-content fade-in">
                            <h1 className="hero-title">Instant, AI-Powered BSOD Analysis</h1>
                            <p className="hero-subtitle">
                                Stop guessing. Upload your Windows .dmp or .zip files and get an expert-level diagnosis in seconds. Our AI analyzes crash dumps to identify the root cause and provide actionable solutions.
                            </p>
                            <FileUploader onFilesAdded={handleFilesAdded} />
                        </div>
                    </div>
                </section>
                
                <div className="container" style={{paddingTop: '2rem'}}>
                    {error && (
                         <div className="card status-error fade-in" style={{ padding: '1.5rem', color: 'var(--text-primary)'}} role="alert">
                             <strong>Error: </strong>
                             <span>{error}</span>
                         </div>
                    )}

                    {dumpFiles.length > 0 && (
                        <section id="analysis-results" style={{ marginTop: '2rem' }}>
                             <h2 style={{ textAlign: 'center', marginBottom: '2rem' }}>Analysis Queue</h2>
                             <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem'}}>
                                {dumpFiles.map((dumpFile, index) => (
                                    <AnalysisReportCard
                                        key={dumpFile.id}
                                        dumpFile={dumpFile}
                                        onUpdateAdvancedAnalysis={handleUpdateAdvancedAnalysis}
                                        style={{ animationDelay: `${index * 100}ms` }}
                                    />
                                ))}
                            </div>
                        </section>
                    )}
                </div>


                <section id="how-it-works" className="features">
                    <div className="container">
                        <div style={{ textAlign: 'center' }}>
                             <h2>How It Works</h2>
                             <p style={{ color: 'var(--text-secondary)', maxWidth: '600px', margin: '1rem auto 0' }}>A simple, three-step process to solve your system crashes.</p>
                        </div>
                        <div className="features-grid">
                            <div className="feature-card fade-in" style={{animationDelay: '100ms'}}>
                                <UploadFeatureIcon className="feature-icon" />
                                <h3 className="feature-title">1. Upload Dump File</h3>
                                <p className="feature-description">Drag and drop your .dmp file or a .zip archive containing it. The system automatically extracts and prepares it for analysis.</p>
                            </div>
                            <div className="feature-card fade-in" style={{animationDelay: '200ms'}}>
                                <AnalyzeFeatureIcon className="feature-icon" />
                                <h3 className="feature-title">2. AI-Powered Analysis</h3>
                                <p className="feature-description">Our AI, trained on millions of crash reports, performs a deep analysis to find the probable cause, culprit driver, and call stack.</p>
                            </div>
                             <div className="feature-card fade-in" style={{animationDelay: '300ms'}}>
                                <ResolveFeatureIcon className="feature-icon" />
                                <h3 className="feature-title">3. Get Actionable Steps</h3>
                                <p className="feature-description">Receive clear, step-by-step recommendations to fix the problem, from updating drivers to running system checks.</p>
                            </div>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="footer">
                <div className="container">
                    <div className="footer-content">
                        <div className="footer-brand">
                            <span className="footer-company">Fara Technologies LLC</span>
                            <span className="footer-tagline">In partnership with WindowsForum</span>
                        </div>
                        <div className="footer-links">
                            <a href="https://windowsforum.com" target="_blank" rel="noopener noreferrer" className="footer-link">WindowsForum</a>
                             <a href="https://windowsforum.com/privacy-policy" className="footer-link">Privacy Policy</a>
                        </div>
                    </div>
                </div>
            </footer>
        </>
    );
};

export default App;