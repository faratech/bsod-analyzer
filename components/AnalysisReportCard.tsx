import React, { useState, Suspense, lazy } from 'react';
import { DumpFile, FileStatus } from '../types';
import { runAdvancedAnalysis } from '../services/geminiProxy';
import Loader from './Loader';
import { FileIcon, ZipIcon, ChevronDownIcon, ChevronUpIcon, TerminalIcon, ClipboardIcon, DownloadIcon, ShareIcon, TwitterIcon, CheckIcon } from './Icons';

// Lazy load ReactMarkdown and remarkGfm
const ReactMarkdown = lazy(() => import('react-markdown'));
const remarkGfmModule = import('remark-gfm');

// Wrapper component for lazy-loaded markdown
const LazyMarkdown: React.FC<{ children: string }> = ({ children }) => {
    const [remarkGfm, setRemarkGfm] = useState<any>(null);
    
    React.useEffect(() => {
        remarkGfmModule.then(module => setRemarkGfm(() => module.default));
    }, []);
    
    return (
        <Suspense fallback={<div style={{ padding: '1rem' }}>Loading...</div>}>
            <ReactMarkdown
                remarkPlugins={remarkGfm ? [remarkGfm] : []}
                components={{
                    pre: ({node, ...props}) => <pre className="code-block" style={{margin: 0}} {...props} />,
                    code: ({ node, inline, ...props }: any) => <code style={{fontFamily: 'Jetbrains Mono, monospace', backgroundColor: inline ? 'var(--bg-secondary)' : 'transparent', padding: inline ? '0.2em 0.4em' : 0, borderRadius: '3px'}} {...props} />,
                    a: ({node, ...props}) => <a style={{color: 'var(--brand-primary)'}} target="_blank" rel="noopener noreferrer" {...props} />,
                }}
            >
                {children}
            </ReactMarkdown>
        </Suspense>
    );
};

interface AnalysisReportCardProps {
    dumpFile: DumpFile;
    onUpdateAdvancedAnalysis: (fileId: string, tool: string, result: string) => void;
    style?: React.CSSProperties;
}

const ADVANCED_TOOLS = [
    { id: '!analyze -v', name: 'In-Depth Crash Analysis (!analyze -v)' },
    { id: 'lm kv', name: 'List Loaded Modules (lm kv)' },
    { id: '!process 0 0', name: 'List Active Processes (!process 0 0)' },
    { id: '!vm', name: 'Virtual Memory Usage (!vm)' },
];

const AnalysisReportCard: React.FC<AnalysisReportCardProps> = ({ dumpFile, onUpdateAdvancedAnalysis, style }) => {
    const [isExpanded, setIsExpanded] = useState(dumpFile.status !== FileStatus.PENDING);
    const [runningTool, setRunningTool] = useState<string | null>(null);
    const [toolError, setToolError] = useState<string | null>(null);
    const [copySuccess, setCopySuccess] = useState<boolean>(false);

    const handleRunTool = async (tool: string) => {
        if (!dumpFile.report || !tool || runningTool) return;
        setRunningTool(tool);
        setToolError(null);
        try {
            const result = await runAdvancedAnalysis(tool, dumpFile);
            onUpdateAdvancedAnalysis(dumpFile.id, tool, result);
        } catch (error) {
            console.error(error);
            setToolError(`Failed to run tool: ${tool}. Please try again.`);
        } finally {
            setRunningTool(null);
        }
    };

    const generateMarkdownReport = (): string => {
        if (!dumpFile.report) return '';
        const { summary, probableCause, culprit, recommendations, stackTrace, advancedAnalyses } = dumpFile.report;

        let report = `# BSOD Analysis Report for ${dumpFile.file.name}\n\n`;
        report += `## Summary\n${summary}\n\n`;
        report += `## Probable Cause\n**Culprit:** \`${culprit}\`\n\n${probableCause}\n\n`;
        report += `## Recommendations\n${recommendations.map(r => `- ${r}`).join('\n')}\n\n`;
        report += `## Reconstructed Stack Trace\n\`\`\`\n${stackTrace.join('\n')}\n\`\`\`\n\n`;
        
        if (advancedAnalyses && advancedAnalyses.length > 0) {
            report += `## Advanced Analysis Results\n`;
            advancedAnalyses.forEach(analysis => {
                report += `### Output for \`${analysis.tool}\`\n\n\`\`\`markdown\n${analysis.result}\n\`\`\`\n\n`;
            });
        }
        return report;
    };

    const handleCopy = () => {
        if (copySuccess || !dumpFile.report) return;
        const markdownContent = generateMarkdownReport();
        navigator.clipboard.writeText(markdownContent).then(() => {
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 2000);
        }).catch(err => {
            console.error('Failed to copy text: ', err);
            alert('Failed to copy report to clipboard.');
        });
    };
    
    const handleExport = () => {
        if (!dumpFile.report) return;
        const markdownContent = generateMarkdownReport();
        const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${dumpFile.file.name.replace(/\.[^/.]+$/, "")}-analysis.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const getShareUrl = (): string => {
        const canonicalLink = document.querySelector<HTMLLinkElement>("link[rel='canonical']");
        return canonicalLink ? canonicalLink.href : window.location.href;
    };

    const handleShare = async () => {
        if (navigator.share && dumpFile.report) {
            const shareUrl = getShareUrl();
            const shareText = `BSOD Analysis for ${dumpFile.file.name}:\n\nSummary: ${dumpFile.report.summary}\n\nProbable Cause: ${dumpFile.report.probableCause}\n\nCheck out the BSOD AI Analyzer.`;
            try {
                await navigator.share({
                    title: `BSOD Analysis: ${dumpFile.file.name}`,
                    text: shareText,
                    url: shareUrl,
                });
            } catch (error) {
                console.error('Error sharing:', error);
            }
        }
    };
    
    const handleShareToX = () => {
        if (!dumpFile.report) return;
        const shareUrl = getShareUrl();
        const text = `My PC crashed, but the BSOD AI Analyzer gave me this diagnosis: "${dumpFile.report.summary}" Check out the tool:`;
        const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`;
        window.open(url, '_blank', 'noopener,noreferrer');
    };


    const FileTypeIcon = dumpFile.file.name.toLowerCase().endsWith('.zip') ? ZipIcon : FileIcon;
    const fileSize = (dumpFile.file.size / 1024).toFixed(2);

    const getStatusBadge = () => {
        switch (dumpFile.status) {
            case FileStatus.ANALYZED: return <div className="result-status status-completed">Completed</div>;
            case FileStatus.ERROR: return <div className="result-status status-error">Error</div>;
            case FileStatus.ANALYZING: return <div className="result-status status-analyzing" style={{display: 'flex', alignItems: 'center', gap: '0.5rem'}}><Loader /> Analyzing</div>;
            default: return <div className="result-status status-pending">Pending</div>;
        }
    }

    const renderContent = () => {
        switch (dumpFile.status) {
            case FileStatus.ANALYZING:
                 return <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem'}}><Loader /><span style={{marginLeft: '1rem', color: 'var(--text-secondary)'}}>Analyzing...</span></div>;
            case FileStatus.ERROR:
                return (
                    <div style={{padding: '1.5rem', color: 'var(--text-primary)'}}>
                        <p><strong>Analysis Failed</strong></p>
                        <p style={{color: 'var(--text-secondary)'}}>{dumpFile.error}</p>
                    </div>
                );
            case FileStatus.ANALYZED:
                if (!dumpFile.report) return null;
                const alreadyRunTools = new Set(dumpFile.report.advancedAnalyses?.map(a => a.tool) || []);
                return (
                    <div style={{padding: '1.5rem'}}>

                        <div className="report-actions">
                            <button
                                className={`action-btn ${copySuccess ? 'copied' : ''}`}
                                onClick={handleCopy}
                                title={copySuccess ? "Copied!" : "Copy Report to Clipboard"}
                                aria-label={copySuccess ? "Copied report to clipboard" : "Copy report to clipboard"}
                            >
                                {copySuccess ? <CheckIcon /> : <ClipboardIcon />}
                            </button>
                            <button className="action-btn" onClick={handleExport} title="Export as Markdown (.md)" aria-label="Export report as markdown file">
                                <DownloadIcon />
                            </button>
                            {typeof navigator.share === 'function' && (
                                <button className="action-btn" onClick={handleShare} title="Share Report" aria-label="Share report">
                                    <ShareIcon />
                                </button>
                            )}
                            <button className="action-btn" onClick={handleShareToX} title="Share on X" aria-label="Share report on X">
                                <TwitterIcon />
                            </button>
                        </div>


                        <p style={{fontStyle: 'italic', marginBottom: '1.5rem'}}>"...{dumpFile.report.summary}"</p>
                        
                        <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1.5rem'}}>
                            <div>
                                <h3>Probable Cause</h3>
                                <p>{dumpFile.report.probableCause}</p>
                                <div style={{ marginTop: '1rem' }}>
                                    <span className="code-block" style={{display: 'inline-block', padding: '0.25rem 0.75rem', fontSize: '0.8rem'}}>Culprit: {dumpFile.report.culprit}</span>
                                </div>
                            </div>
                            <div>
                                <h3>Recommendations</h3>
                                <ul style={{listStyle: 'disc', paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem'}}>
                                    {dumpFile.report.recommendations.map((rec, i) => <li key={i}>{rec}</li>)}
                                </ul>
                            </div>
                        </div>

                        <div style={{marginTop: '1.5rem'}}>
                             <h3>Reconstructed Stack Trace</h3>
                             <pre className="code-block">
                                 {dumpFile.report.stackTrace.join('\n')}
                             </pre>
                        </div>
                        
                        <div style={{marginTop: '1rem', padding: '0.75rem', backgroundColor: 'var(--bg-secondary)', borderRadius: '0.5rem'}}>
                            <p style={{fontSize: '0.875rem', color: 'var(--text-secondary)'}}>
                                * You can verify this AI analysis with <a href="https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/getting-started-with-windbg" target="_blank" rel="noopener noreferrer" style={{color: 'var(--brand-primary)'}}>Microsoft WinDbg</a>
                            </p>
                        </div>
                        
                        <div style={{marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-primary)'}}>
                            <h3 style={{display: 'flex', alignItems: 'center', gap: '0.5rem'}}><TerminalIcon className="w-5 h-5"/> Advanced Tools</h3>
                            <div style={{display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '1rem', flexWrap: 'wrap'}}>
                               <select
                                    value=""
                                    onChange={(e) => handleRunTool(e.target.value)}
                                    disabled={!!runningTool}
                                    aria-label="Select an advanced tool to run"
                                >
                                    <option value="" disabled>Select a tool to run...</option>
                                    {ADVANCED_TOOLS.map(tool => (
                                        <option key={tool.id} value={tool.id} disabled={alreadyRunTools.has(tool.id) || !!runningTool}>
                                            {tool.name} {alreadyRunTools.has(tool.id) ? '(✓ Complete)' : ''}
                                        </option>
                                    ))}
                                </select>
                                {runningTool && <div style={{display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem'}}><Loader /><span >Running...</span></div>}
                            </div>
                            {toolError && <p style={{color: 'var(--status-error)', fontSize: '0.875rem', marginTop: '0.5rem'}}>{toolError}</p>}
                        </div>

                        {dumpFile.report.advancedAnalyses && dumpFile.report.advancedAnalyses.length > 0 && (
                            <div style={{marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem'}}>
                                {dumpFile.report.advancedAnalyses.map((analysis, index) => (
                                    <div key={index} style={{backgroundColor: 'var(--bg-primary)', borderRadius: '0.5rem', border: '1px solid var(--border-primary)'}}>
                                        <p style={{ fontFamily: 'Jetbrains Mono, monospace', fontSize: '0.875rem', backgroundColor: 'var(--bg-secondary)', padding: '0.5rem 1rem', borderBottom: '1px solid var(--border-primary)', color: 'var(--text-primary)'}}>{`> ${analysis.tool}`}</p>
                                        <div style={{padding: '0.5rem 1rem 1rem', overflowX: 'auto'}}>
                                            <LazyMarkdown>{analysis.result}</LazyMarkdown>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            default: // PENDING
                return <div style={{padding: '1.5rem', color: 'var(--text-tertiary)'}}>Pending analysis...</div>;
        }
    };

    return (
        <div className="card analysis-result fade-in" style={style}>
            <div className="result-header">
                <div style={{display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap'}}>
                    <FileTypeIcon />
                    <span className="result-filename">{dumpFile.file.name}</span>
                    <span style={{fontSize: '0.75rem', color: 'var(--text-tertiary)'}}>({fileSize} KB)</span>
                    {getStatusBadge()}
                </div>
                <button onClick={() => setIsExpanded(!isExpanded)} style={{background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.5rem'}} aria-expanded={isExpanded} aria-controls={`report-content-${dumpFile.id}`}>
                    {isExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
                </button>
            </div>
            <div id={`report-content-${dumpFile.id}`} className={`expandable-content ${isExpanded ? 'expanded' : ''}`}>
              <div className="content-inner" style={{borderTop: `1px solid ${isExpanded ? 'var(--border-primary)' : 'transparent'}`, transition: 'border-color 0.4s ease-in-out'}}>
                {renderContent()}
              </div>
            </div>
        </div>
    );
};

export default AnalysisReportCard;