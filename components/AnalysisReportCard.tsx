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
    const [remarkGfm, setRemarkGfm] = useState<typeof import('remark-gfm').default | null>(null);
    
    React.useEffect(() => {
        remarkGfmModule.then(module => setRemarkGfm(() => module.default));
    }, []);
    
    return (
        <Suspense fallback={<div style={{ padding: '1rem' }}>Loading...</div>}>
            <ReactMarkdown
                remarkPlugins={remarkGfm ? [remarkGfm] : []}
                components={{
                    pre: ({node, ...props}) => <pre className="code-block" style={{margin: 0}} {...props} />,
                    code: ({ node, className, children, ...props }) => {
                        const isInline = !className?.includes('language-');
                        return <code style={{fontFamily: 'Jetbrains Mono, monospace', backgroundColor: isInline ? 'var(--bg-secondary)' : 'transparent', padding: isInline ? '0.2em 0.4em' : 0, borderRadius: '3px'}} className={className} {...props}>{children}</code>;
                    },
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
        const { summary, probableCause, culprit, recommendations, stackTrace, advancedAnalyses, bugCheck, crashLocation, registers, loadedModules, driverWarnings, hardwareError, parameterAnalysis } = dumpFile.report;

        let report = `# BSOD Analysis Report for ${dumpFile.file.name}\n\n`;

        // Bug Check Info
        if (bugCheck) {
            report += `## Bug Check\n`;
            report += `**${bugCheck.code}** - ${bugCheck.name}\n\n`;
            if (bugCheck.parameters && bugCheck.parameters.length > 0) {
                report += `| Parameter | Value | Meaning |\n|-----------|-------|--------|\n`;
                bugCheck.parameters.forEach((p, i) => {
                    report += `| Param ${i + 1} | \`${p.value}\` | ${p.meaning} |\n`;
                });
                report += `\n`;
            }
        }

        // Parameter Analysis
        if (parameterAnalysis && parameterAnalysis.length > 0) {
            report += `## Parameter Analysis\n\n`;
            report += `| Parameter | Value | Decoded | Significance |\n|-----------|-------|---------|---------------|\n`;
            parameterAnalysis.forEach(param => {
                report += `| ${param.parameter} | \`${param.rawValue}\` | ${param.decoded} | ${param.significance} |\n`;
            });
            report += `\n`;
        }

        // Hardware Error Info
        if (hardwareError && hardwareError.isHardwareError) {
            report += `## 🔥 Hardware Error Detected\n\n`;
            report += `**Severity:** ${hardwareError.severity.toUpperCase()}\n`;
            report += `**Error Type:** ${hardwareError.errorType}\n`;
            report += `**Component:** ${hardwareError.component}\n\n`;
            if (hardwareError.details.length > 0) {
                report += `### Technical Details\n\`\`\`\n`;
                hardwareError.details.forEach(detail => {
                    report += `${detail}\n`;
                });
                report += `\`\`\`\n\n`;
            }
            if (hardwareError.recommendations.length > 0) {
                report += `### Hardware-Specific Recommendations\n`;
                hardwareError.recommendations.forEach(rec => {
                    report += `- ${rec}\n`;
                });
                report += `\n`;
            }
        }

        // Crash Location
        if (crashLocation) {
            report += `## Crash Location\n`;
            report += `**Module:** \`${crashLocation.module}\`\n`;
            report += `**Address:** \`${crashLocation.address}\`${crashLocation.offset ? ` (${crashLocation.offset})` : ''}\n\n`;
        }

        // Driver Warnings
        if (driverWarnings && driverWarnings.length > 0) {
            report += `## Known Problematic Drivers\n\n`;
            driverWarnings.forEach(warning => {
                report += `### ${warning.driverName}${warning.isAssociatedWithBugCheck ? ' ⚠️ RELATED TO CRASH' : ''}\n`;
                report += `- **Display Name:** ${warning.displayName}\n`;
                report += `- **Manufacturer:** ${warning.manufacturer}\n`;
                report += `- **Category:** ${warning.category}\n`;
                report += `- **Known Issues:**\n`;
                warning.issues.forEach(issue => {
                    report += `  - ${issue}\n`;
                });
                if (warning.recommendations.length > 0) {
                    report += `- **Recommendations:**\n`;
                    warning.recommendations.forEach(rec => {
                        report += `  - ${rec}\n`;
                    });
                }
                report += `\n`;
            });
        }

        report += `## Summary\n${summary}\n\n`;
        report += `## Probable Cause\n**Culprit:** \`${culprit}\`\n\n${probableCause}\n\n`;
        report += `## Recommendations\n${recommendations.map(r => `- ${r}`).join('\n')}\n\n`;

        // CPU Registers
        if (registers && Object.keys(registers).length > 0) {
            report += `## CPU Registers at Crash\n\`\`\`\n`;
            Object.entries(registers).forEach(([reg, val]) => {
                if (val) report += `${reg.toUpperCase()}: ${val}\n`;
            });
            report += `\`\`\`\n\n`;
        }

        // Loaded Modules
        if (loadedModules && loadedModules.length > 0) {
            report += `## Loaded Modules (${loadedModules.length})\n`;
            loadedModules.forEach(mod => {
                const marker = mod.isCulprit ? '**[CRASH]** ' : '';
                report += `- ${marker}\`${mod.name}\`${mod.base ? ` @ ${mod.base}` : ''}\n`;
            });
            report += `\n`;
        } else if (stackTrace && stackTrace.length > 0) {
            report += `## Loaded Modules\n\`\`\`\n${stackTrace.join('\n')}\n\`\`\`\n\n`;
        }

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
                const { bugCheck, crashLocation, registers, loadedModules, driverWarnings, hardwareError, parameterAnalysis } = dumpFile.report;

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

                        {/* Bug Check Header */}
                        {bugCheck && (
                            <div style={{
                                backgroundColor: 'var(--status-error-bg)',
                                border: '1px solid var(--status-error)',
                                borderRadius: '0.5rem',
                                padding: '1rem',
                                marginBottom: '1.5rem'
                            }}>
                                <div style={{display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap'}}>
                                    <span style={{
                                        fontFamily: 'Jetbrains Mono, monospace',
                                        fontSize: '1.25rem',
                                        fontWeight: 'bold',
                                        color: 'var(--status-error)'
                                    }}>{bugCheck.code}</span>
                                    <span style={{
                                        fontSize: '1.1rem',
                                        fontWeight: '600',
                                        color: 'var(--text-primary)'
                                    }}>{bugCheck.name}</span>
                                </div>
                                {bugCheck.parameters && bugCheck.parameters.length > 0 && (
                                    <div style={{marginTop: '0.75rem', fontSize: '0.875rem'}}>
                                        {bugCheck.parameters.map((param, i) => (
                                            <div key={i} style={{
                                                display: 'flex',
                                                gap: '0.5rem',
                                                marginTop: '0.25rem',
                                                color: 'var(--text-secondary)'
                                            }}>
                                                <span style={{fontFamily: 'Jetbrains Mono, monospace', minWidth: '140px'}}>{param.value}</span>
                                                <span style={{color: 'var(--text-tertiary)'}}>→</span>
                                                <span>{param.meaning}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Parameter Analysis from AI */}
                        {parameterAnalysis && parameterAnalysis.length > 0 && (
                            <div style={{
                                backgroundColor: 'var(--bg-secondary)',
                                borderRadius: '0.5rem',
                                padding: '1rem',
                                marginBottom: '1.5rem',
                                border: '1px solid var(--border-primary)'
                            }}>
                                <h3 style={{
                                    margin: '0 0 0.75rem 0',
                                    fontSize: '0.9rem',
                                    color: 'var(--text-secondary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem'
                                }}>
                                    🔍 Parameter Analysis
                                </h3>
                                <div style={{display: 'flex', flexDirection: 'column', gap: '0.5rem'}}>
                                    {parameterAnalysis.map((param, i) => (
                                        <div key={i} style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'auto 1fr',
                                            gap: '0.5rem 1rem',
                                            padding: '0.5rem',
                                            backgroundColor: 'var(--bg-primary)',
                                            borderRadius: '0.375rem',
                                            fontSize: '0.85rem'
                                        }}>
                                            <span style={{
                                                fontFamily: 'Jetbrains Mono, monospace',
                                                color: 'var(--brand-primary)',
                                                fontWeight: '600'
                                            }}>{param.rawValue}</span>
                                            <span style={{color: 'var(--text-primary)', fontWeight: '500'}}>{param.decoded}</span>
                                            <span style={{color: 'var(--text-tertiary)', fontSize: '0.8rem'}}>{param.parameter}</span>
                                            <span style={{color: 'var(--text-secondary)', fontSize: '0.8rem'}}>{param.significance}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Hardware Error Alert */}
                        {hardwareError && hardwareError.isHardwareError && (
                            <div style={{
                                backgroundColor: 'rgba(220, 38, 38, 0.1)',
                                border: '2px solid #dc2626',
                                borderRadius: '0.5rem',
                                padding: '1rem',
                                marginBottom: '1.5rem'
                            }}>
                                <h3 style={{
                                    margin: '0 0 0.75rem 0',
                                    fontSize: '1rem',
                                    color: '#dc2626',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem'
                                }}>
                                    <span style={{fontSize: '1.25rem'}}>🔥</span>
                                    Hardware Error Detected
                                    <span style={{
                                        backgroundColor: '#dc2626',
                                        color: 'white',
                                        padding: '0.15rem 0.5rem',
                                        borderRadius: '0.25rem',
                                        fontSize: '0.7rem',
                                        fontWeight: '600',
                                        textTransform: 'uppercase'
                                    }}>{hardwareError.severity}</span>
                                </h3>
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'auto 1fr',
                                    gap: '0.5rem 1rem',
                                    fontSize: '0.875rem',
                                    marginBottom: '0.75rem'
                                }}>
                                    <span style={{color: 'var(--text-tertiary)'}}>Error Type:</span>
                                    <span style={{color: 'var(--text-primary)', fontWeight: '500'}}>{hardwareError.errorType}</span>
                                    <span style={{color: 'var(--text-tertiary)'}}>Component:</span>
                                    <span style={{color: 'var(--text-primary)', fontWeight: '500'}}>{hardwareError.component}</span>
                                </div>
                                {hardwareError.details.length > 0 && (
                                    <div style={{
                                        backgroundColor: 'var(--bg-primary)',
                                        padding: '0.75rem',
                                        borderRadius: '0.375rem',
                                        fontSize: '0.8rem',
                                        fontFamily: 'Jetbrains Mono, monospace',
                                        color: 'var(--text-secondary)',
                                        marginBottom: '0.75rem',
                                        maxHeight: '120px',
                                        overflowY: 'auto'
                                    }}>
                                        {hardwareError.details.slice(0, 5).map((detail, i) => (
                                            <div key={i}>{detail}</div>
                                        ))}
                                    </div>
                                )}
                                <div style={{
                                    fontSize: '0.8rem',
                                    color: '#dc2626',
                                    fontWeight: '500'
                                }}>
                                    This error indicates a likely hardware problem. See recommendations below.
                                </div>
                            </div>
                        )}

                        {/* Crash Location */}
                        {crashLocation && (
                            <div style={{
                                backgroundColor: 'var(--bg-secondary)',
                                borderRadius: '0.5rem',
                                padding: '1rem',
                                marginBottom: '1.5rem',
                                border: '1px solid var(--border-primary)'
                            }}>
                                <h3 style={{margin: '0 0 0.5rem 0', fontSize: '0.9rem', color: 'var(--text-secondary)'}}>Crash Location</h3>
                                <div style={{display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap'}}>
                                    <span style={{
                                        backgroundColor: 'var(--brand-primary)',
                                        color: 'white',
                                        padding: '0.25rem 0.75rem',
                                        borderRadius: '0.25rem',
                                        fontWeight: '600',
                                        fontSize: '0.95rem'
                                    }}>{crashLocation.module}</span>
                                    <span style={{fontFamily: 'Jetbrains Mono, monospace', fontSize: '0.85rem', color: 'var(--text-secondary)'}}>
                                        at {crashLocation.address}{crashLocation.offset && ` (${crashLocation.offset})`}
                                    </span>
                                    <button
                                        onClick={() => navigator.clipboard.writeText(crashLocation.module)}
                                        style={{
                                            background: 'none',
                                            border: 'none',
                                            cursor: 'pointer',
                                            padding: '0.25rem',
                                            color: 'var(--text-tertiary)'
                                        }}
                                        title="Copy driver name"
                                    >
                                        <ClipboardIcon />
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Driver Warnings */}
                        {driverWarnings && driverWarnings.length > 0 && (
                            <div style={{
                                backgroundColor: 'var(--bg-secondary)',
                                border: '1px solid #f59e0b',
                                borderRadius: '0.5rem',
                                padding: '1rem',
                                marginBottom: '1.5rem'
                            }}>
                                <h3 style={{
                                    margin: '0 0 0.75rem 0',
                                    fontSize: '0.95rem',
                                    color: '#f59e0b',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem'
                                }}>
                                    <span style={{fontSize: '1.1rem'}}>⚠</span>
                                    Known Problematic Drivers Detected
                                </h3>
                                <div style={{display: 'flex', flexDirection: 'column', gap: '0.75rem'}}>
                                    {driverWarnings.slice(0, 3).map((warning, i) => (
                                        <div key={i} style={{
                                            backgroundColor: 'var(--bg-primary)',
                                            padding: '0.75rem',
                                            borderRadius: '0.375rem',
                                            border: warning.isAssociatedWithBugCheck ? '1px solid var(--status-error)' : '1px solid var(--border-primary)'
                                        }}>
                                            <div style={{display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem'}}>
                                                <span style={{
                                                    fontFamily: 'Jetbrains Mono, monospace',
                                                    fontWeight: '600',
                                                    color: warning.isAssociatedWithBugCheck ? 'var(--status-error)' : 'var(--text-primary)'
                                                }}>{warning.driverName}</span>
                                                <span style={{
                                                    backgroundColor: 'var(--bg-secondary)',
                                                    padding: '0.1rem 0.5rem',
                                                    borderRadius: '0.25rem',
                                                    fontSize: '0.7rem',
                                                    color: 'var(--text-tertiary)'
                                                }}>{warning.category}</span>
                                                {warning.isAssociatedWithBugCheck && (
                                                    <span style={{
                                                        backgroundColor: 'var(--status-error)',
                                                        color: 'white',
                                                        padding: '0.1rem 0.4rem',
                                                        borderRadius: '0.2rem',
                                                        fontSize: '0.65rem',
                                                        fontWeight: '600'
                                                    }}>RELATED TO CRASH</span>
                                                )}
                                            </div>
                                            <div style={{fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem'}}>
                                                {warning.displayName} ({warning.manufacturer})
                                            </div>
                                            <ul style={{
                                                margin: 0,
                                                paddingLeft: '1.25rem',
                                                fontSize: '0.8rem',
                                                color: 'var(--text-secondary)'
                                            }}>
                                                {warning.issues.slice(0, 2).map((issue, j) => (
                                                    <li key={j}>{issue}</li>
                                                ))}
                                            </ul>
                                            {warning.recommendations.length > 0 && (
                                                <div style={{
                                                    marginTop: '0.5rem',
                                                    fontSize: '0.75rem',
                                                    color: 'var(--brand-primary)'
                                                }}>
                                                    Tip: {warning.recommendations[0]}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                                {driverWarnings.length > 3 && (
                                    <div style={{
                                        marginTop: '0.5rem',
                                        fontSize: '0.8rem',
                                        color: 'var(--text-tertiary)'
                                    }}>
                                        +{driverWarnings.length - 3} more problematic drivers detected
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Summary */}
                        <p style={{fontStyle: 'italic', marginBottom: '1.5rem', color: 'var(--text-secondary)'}}>"...{dumpFile.report.summary}"</p>

                        <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem'}}>
                            <div>
                                <h3>Probable Cause</h3>
                                <p>{dumpFile.report.probableCause}</p>
                                {!crashLocation && (
                                    <div style={{ marginTop: '1rem' }}>
                                        <span className="code-block" style={{display: 'inline-block', padding: '0.25rem 0.75rem', fontSize: '0.8rem'}}>Culprit: {dumpFile.report.culprit}</span>
                                    </div>
                                )}
                            </div>
                            <div>
                                <h3>Recommendations</h3>
                                <ul style={{listStyle: 'disc', paddingLeft: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem'}}>
                                    {dumpFile.report.recommendations.map((rec, i) => <li key={i}>{rec}</li>)}
                                </ul>
                            </div>
                        </div>

                        {/* Register Context */}
                        {registers && Object.keys(registers).length > 0 && (
                            <div style={{marginTop: '1.5rem'}}>
                                <h3>CPU Registers at Crash</h3>
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                                    gap: '0.5rem',
                                    backgroundColor: 'var(--bg-secondary)',
                                    padding: '1rem',
                                    borderRadius: '0.5rem',
                                    fontFamily: 'Jetbrains Mono, monospace',
                                    fontSize: '0.85rem'
                                }}>
                                    {Object.entries(registers).map(([reg, val]) => val && (
                                        <div key={reg} style={{display: 'flex', justifyContent: 'space-between'}}>
                                            <span style={{color: 'var(--brand-primary)', fontWeight: '600'}}>{reg.toUpperCase()}:</span>
                                            <span style={{color: 'var(--text-secondary)'}}>{val}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Loaded Modules */}
                        {loadedModules && loadedModules.length > 0 && (
                            <div style={{marginTop: '1.5rem'}}>
                                <h3>Loaded Modules ({loadedModules.length})</h3>
                                <div style={{
                                    maxHeight: '200px',
                                    overflowY: 'auto',
                                    backgroundColor: 'var(--bg-secondary)',
                                    padding: '0.75rem',
                                    borderRadius: '0.5rem',
                                    fontSize: '0.85rem'
                                }}>
                                    {loadedModules.map((mod, i) => (
                                        <div key={i} style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.5rem',
                                            padding: '0.25rem 0',
                                            borderBottom: i < loadedModules.length - 1 ? '1px solid var(--border-primary)' : 'none'
                                        }}>
                                            {mod.isCulprit && (
                                                <span style={{
                                                    backgroundColor: 'var(--status-error)',
                                                    color: 'white',
                                                    padding: '0.1rem 0.4rem',
                                                    borderRadius: '0.2rem',
                                                    fontSize: '0.7rem',
                                                    fontWeight: '600'
                                                }}>CRASH</span>
                                            )}
                                            <span style={{
                                                fontFamily: 'Jetbrains Mono, monospace',
                                                color: mod.isCulprit ? 'var(--status-error)' : 'var(--text-primary)',
                                                fontWeight: mod.isCulprit ? '600' : '400'
                                            }}>{mod.name}</span>
                                            {mod.base && (
                                                <span style={{color: 'var(--text-tertiary)', fontSize: '0.75rem'}}>{mod.base}</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Legacy Stack Trace - only show if no enhanced data */}
                        {(!loadedModules || loadedModules.length === 0) && dumpFile.report.stackTrace && dumpFile.report.stackTrace.length > 0 && (
                            <div style={{marginTop: '1.5rem'}}>
                                <h3>Loaded Modules</h3>
                                <pre className="code-block">
                                    {dumpFile.report.stackTrace.join('\n')}
                                </pre>
                            </div>
                        )}

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
                    {/* Show "Previously Analyzed" after analysis completes from cache */}
                    {dumpFile.cached && dumpFile.status === FileStatus.ANALYZED && (
                        <div
                            className="result-status"
                            style={{
                                backgroundColor: 'var(--bg-tertiary)',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-primary)'
                            }}
                            title="This file was previously analyzed. Results loaded from cache."
                        >
                            Previously Analyzed
                        </div>
                    )}
                    {/* Show "Cached" before analysis starts if detected in pre-check */}
                    {dumpFile.knownCached && dumpFile.status === FileStatus.PENDING && (
                        <div
                            className="result-status"
                            style={{
                                backgroundColor: 'var(--status-success-bg)',
                                color: 'var(--status-success)',
                                border: '1px solid var(--status-success)'
                            }}
                            title="This file was previously analyzed. Analysis will load instantly from cache."
                        >
                            Cached
                        </div>
                    )}
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