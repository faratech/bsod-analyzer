import React, { useState, useCallback } from 'react';
import { DumpFile, FileStatus } from './types';
import FileUploader from './components/FileUploader';
import Logo from './components/Logo';
import Footer from './components/Footer';
import ErrorAlert from './components/ErrorAlert';
import HeroSection from './components/HeroSection';
import FeaturesSection from './components/FeaturesSection';
import AnalysisResults from './components/AnalysisResults';
import { AnalyzeIcon, UploadFeatureIcon, AnalyzeFeatureIcon, ResolveFeatureIcon } from './components/Icons';
import { useFileProcessor } from './hooks/useFileProcessor';
import { useAnalysis } from './hooks/useAnalysis';

const App: React.FC = () => {
    const [dumpFiles, setDumpFiles] = useState<DumpFile[]>([]);
    const { processFiles, addFilesToState, error: fileError } = useFileProcessor();
    const { isAnalyzing, error: analysisError, analyzeFiles, updateAdvancedAnalysis } = useAnalysis();
    
    const error = fileError || analysisError;

    const handleFilesAdded = useCallback(async (acceptedFiles: File[]) => {
        const newDumpFiles = await processFiles(acceptedFiles);
        setDumpFiles(prevFiles => addFilesToState(newDumpFiles, prevFiles));
    }, [processFiles, addFilesToState]);

    const handleAnalyze = async () => {
        await analyzeFiles(dumpFiles, setDumpFiles);
    };
    
    const handleUpdateAdvancedAnalysis = (fileId: string, tool: string, result: string) => {
        updateAdvancedAnalysis(fileId, tool, result, dumpFiles, setDumpFiles);
    };

    const pendingFilesCount = dumpFiles.filter(df => df.status === FileStatus.PENDING).length;

    return (
        <>
            <header className="header">
                <div className="container">
                    <div className="header-content">
                        <Logo showLink={false} />
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
                <HeroSection
                    title="Instant, AI-Powered BSOD Analysis"
                    subtitle="Stop guessing. Upload your Windows .dmp or .zip files and get an expert-level diagnosis in seconds. Our AI analyzes crash dumps to identify the root cause and provide actionable solutions."
                    backgroundType="grid"
                >
                    <FileUploader onFilesAdded={handleFilesAdded} currentFileCount={dumpFiles.length} />
                </HeroSection>
                
                <div className="container" style={{paddingTop: '2rem'}}>
                    {error && <ErrorAlert error={error} />}
                    
                    <AnalysisResults
                        title="Analysis Queue"
                        dumpFiles={dumpFiles}
                        onUpdateAdvancedAnalysis={handleUpdateAdvancedAnalysis}
                    />
                </div>


                <FeaturesSection
                    id="how-it-works"
                    title="How It Works"
                    subtitle="A simple, three-step process to solve your system crashes."
                    features={[
                        {
                            icon: <UploadFeatureIcon />,
                            title: "1. Upload Dump File",
                            description: "Drag and drop your .dmp file or a .zip archive containing it. The system automatically extracts and prepares it for analysis."
                        },
                        {
                            icon: <AnalyzeFeatureIcon />,
                            title: "2. AI-Powered Analysis",
                            description: "Our AI, trained on millions of crash reports, performs a deep analysis to find the probable cause, culprit driver, and call stack."
                        },
                        {
                            icon: <ResolveFeatureIcon />,
                            title: "3. Get Actionable Steps",
                            description: "Receive clear, step-by-step recommendations to fix the problem, from updating drivers to running system checks."
                        }
                    ]}
                />
            </main>

            <Footer />
        </>
    );
};

export default App;