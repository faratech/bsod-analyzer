import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import SEO from '../components/SEO';
import StructuredData from '../components/StructuredData';
import { InArticleAd, HorizontalAd } from '../components/AdSense';

const Documentation: React.FC = () => {
    const location = useLocation();
    const [activeSection, setActiveSection] = useState('');

    // Smooth scroll to section
    useEffect(() => {
        if (location.hash) {
            const element = document.querySelector(location.hash);
            if (element) {
                element.scrollIntoView({ behavior: 'smooth' });
            }
        }
    }, [location]);

    // Track active section for navigation highlighting
    useEffect(() => {
        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        setActiveSection(entry.target.id);
                    }
                });
            },
            { rootMargin: '-100px 0px -70% 0px' }
        );

        const sections = document.querySelectorAll('.docs-section');
        sections.forEach((section) => observer.observe(section));

        return () => {
            sections.forEach((section) => observer.unobserve(section));
        };
    }, []);

    // FAQ Structured Data
    const faqData = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": "What is a Windows memory dump file?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "A memory dump (also called a crash dump) is a snapshot of your computer's memory at the exact moment a Blue Screen of Death occurs. Windows creates these files to help diagnose what caused the system to crash. They contain information about running processes, loaded drivers, and system state."
                }
            },
            {
                "@type": "Question",
                "name": "What are the different types of dump files?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "There are three main types: 1) Minidump (64KB-2MB) contains minimal information but is quick to generate. 2) Kernel Memory Dump (1/3 of RAM size) contains all kernel-mode memory. 3) Complete Memory Dump (size equals total RAM) contains the entire contents of physical memory."
                }
            },
            {
                "@type": "Question",
                "name": "Where can I find Windows dump files?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "Minidumps are typically located in C:\\Windows\\Minidump\\. Kernel and Complete dumps are usually saved as C:\\Windows\\MEMORY.DMP. You can check your dump file settings in System Properties > Advanced > Startup and Recovery."
                }
            },
            {
                "@type": "Question",
                "name": "How do I analyze a BSOD dump file?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "Simply upload your .dmp file to BSOD AI Analyzer. Our AI will automatically extract error codes, identify problematic drivers, analyze the call stack, and provide step-by-step solutions to fix the issue."
                }
            },
            {
                "@type": "Question",
                "name": "What does IRQL_NOT_LESS_OR_EQUAL mean?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "IRQL_NOT_LESS_OR_EQUAL (0x0000000A) indicates a driver attempted to access memory at an invalid IRQL level. This is often caused by faulty drivers, hardware issues, or incompatible software. Common fixes include updating drivers, checking RAM, and removing recently installed software."
                }
            }
        ]
    };

    // HowTo Structured Data
    const howToData = {
        "@context": "https://schema.org",
        "@type": "HowTo",
        "name": "How to Analyze Windows BSOD Dump Files",
        "description": "Step-by-step guide to analyzing Windows crash dump files using BSOD AI Analyzer",
        "image": "https://bsod.windowsforum.com/og-image.png",
        "totalTime": "PT2M",
        "estimatedCost": {
            "@type": "MonetaryAmount",
            "currency": "USD",
            "value": "0"
        },
        "supply": [
            {
                "@type": "HowToSupply",
                "name": "Windows dump file (.dmp)"
            }
        ],
        "tool": [
            {
                "@type": "HowToTool",
                "name": "BSOD AI Analyzer"
            }
        ],
        "step": [
            {
                "@type": "HowToStep",
                "name": "Locate your dump file",
                "text": "Navigate to C:\\Windows\\Minidump\\ or C:\\Windows\\MEMORY.DMP to find your crash dump files.",
                "image": "https://bsod.windowsforum.com/step1.png"
            },
            {
                "@type": "HowToStep",
                "name": "Upload the dump file",
                "text": "Go to the BSOD AI Analyzer page and drag-drop your .dmp file or click to browse and select it.",
                "image": "https://bsod.windowsforum.com/step2.png"
            },
            {
                "@type": "HowToStep",
                "name": "Click Analyze",
                "text": "Click the 'Analyze' button to start the AI-powered analysis of your crash dump.",
                "image": "https://bsod.windowsforum.com/step3.png"
            },
            {
                "@type": "HowToStep",
                "name": "Review results",
                "text": "Review the analysis report showing the crash cause, problematic drivers, and recommended solutions.",
                "image": "https://bsod.windowsforum.com/step4.png"
            }
        ]
    };

    return (
        <>
            <SEO 
                title="BSOD Documentation - Crash Dump Analysis Guide"
                description="Complete guide to Windows crash dump analysis. Learn about minidumps, kernel dumps, common BSOD error codes, and step-by-step instructions for using our analyzer."
                keywords="BSOD documentation, crash dump guide, minidump tutorial, kernel dump analysis, Windows error codes, debugging guide"
                canonicalUrl="https://bsod.windowsforum.com/documentation"
            />
            <StructuredData data={faqData} />
            <StructuredData data={howToData} />
            
            <main className="page-content">
                <div className="container">
                    <div className="page-header">
                        <h1 className="page-title">Documentation</h1>
                        <p className="page-subtitle">
                            Complete guide to using BSOD AI Analyzer for Windows crash analysis
                        </p>
                    </div>
                    
                    <div className="docs-layout">
                        {/* Documentation Navigation */}
                        <nav className="docs-nav">
                            <h3>Contents</h3>
                            <ul>
                                <li>
                                    <a 
                                        href="#getting-started" 
                                        className={activeSection === 'getting-started' ? 'active' : ''}
                                    >
                                        Getting Started
                                    </a>
                                </li>
                                <li>
                                    <a 
                                        href="#understanding-dumps" 
                                        className={activeSection === 'understanding-dumps' ? 'active' : ''}
                                    >
                                        Understanding Dump Files
                                    </a>
                                </li>
                                <li>
                                    <a 
                                        href="#finding-files" 
                                        className={activeSection === 'finding-files' ? 'active' : ''}
                                    >
                                        Finding Your Files
                                    </a>
                                </li>
                                <li>
                                    <a 
                                        href="#using-analyzer" 
                                        className={activeSection === 'using-analyzer' ? 'active' : ''}
                                    >
                                        Using the Analyzer
                                    </a>
                                </li>
                                <li>
                                    <a 
                                        href="#analysis-results" 
                                        className={activeSection === 'analysis-results' ? 'active' : ''}
                                    >
                                        Analysis Results
                                    </a>
                                </li>
                                <li>
                                    <a 
                                        href="#common-errors" 
                                        className={activeSection === 'common-errors' ? 'active' : ''}
                                    >
                                        Common BSOD Errors
                                    </a>
                                </li>
                                <li>
                                    <a 
                                        href="#advanced-analysis" 
                                        className={activeSection === 'advanced-analysis' ? 'active' : ''}
                                    >
                                        Advanced Analysis
                                    </a>
                                </li>
                                <li>
                                    <a 
                                        href="#troubleshooting" 
                                        className={activeSection === 'troubleshooting' ? 'active' : ''}
                                    >
                                        Troubleshooting
                                    </a>
                                </li>
                                <li>
                                    <a 
                                        href="#faq" 
                                        className={activeSection === 'faq' ? 'active' : ''}
                                    >
                                        FAQ
                                    </a>
                                </li>
                            </ul>
                        </nav>
                        
                        {/* Documentation Content */}
                        <div className="docs-content">
                            {/* Getting Started */}
                            <section id="getting-started" className="docs-section">
                                <h2>Getting Started</h2>
                                
                                <p>
                                    BSOD AI Analyzer is a free, web-based tool that helps you understand and resolve 
                                    Windows Blue Screen of Death errors. Our AI-powered system analyzes crash dump files 
                                    to identify the root cause and provide actionable solutions.
                                </p>
                                
                                <div className="alert alert-info">
                                    <strong>Quick Start:</strong> Simply drag and drop your .dmp file onto the analyzer 
                                    page and click "Analyze" to get instant results.
                                </div>
                                
                                <h3>What You'll Need</h3>
                                <ul>
                                    <li>A Windows crash dump file (.dmp)</li>
                                    <li>A web browser (Chrome, Firefox, Edge, or Safari)</li>
                                    <li>An internet connection</li>
                                </ul>
                            </section>

                            {/* Understanding Dumps */}
                            <section id="understanding-dumps" className="docs-section">
                                <h2>Understanding Windows Crash Dumps</h2>
                                
                                <h3>What is a Memory Dump?</h3>
                                <p>
                                    A memory dump (also called a crash dump) is a snapshot of your computer's memory 
                                    at the exact moment a Blue Screen of Death occurs. Windows creates these files to 
                                    help diagnose what caused the system to crash.
                                </p>
                                
                                <h3>Types of Dump Files</h3>
                                <dl className="definition-list">
                                    <dt>Minidump (Small Memory Dump)</dt>
                                    <dd>
                                        Typically 64KB to 2MB in size. Contains minimal information: stop code, parameters, 
                                        loaded driver list, and basic system information. Located in <code>C:\Windows\Minidump</code>.
                                    </dd>
                                    
                                    <dt>Kernel Memory Dump</dt>
                                    <dd>
                                        Usually 1/3 of RAM size. Contains all kernel-mode memory, loaded drivers, and 
                                        kernel data structures. More detailed than minidumps but doesn't include user-mode memory.
                                    </dd>
                                    
                                    <dt>Complete Memory Dump</dt>
                                    <dd>
                                        Size equals total RAM. Contains the entire contents of physical memory. Most comprehensive 
                                        but requires significant disk space and longer to generate.
                                    </dd>
                                </dl>
                            </section>

                            {/* Ad placement */}
                            <InArticleAd 
                                className="ad-inline"
                                style={{ margin: '3rem 0' }}
                            />

                            {/* Finding Files */}
                            <section id="finding-files" className="docs-section">
                                <h2>Finding Your Dump Files</h2>
                                
                                <h3>Default Locations</h3>
                                <ul>
                                    <li>Minidumps: <code>C:\Windows\Minidump\</code></li>
                                    <li>Kernel/Complete dumps: <code>C:\Windows\MEMORY.DMP</code></li>
                                </ul>
                                
                                <h3>Checking Dump Settings</h3>
                                <ol className="step-list">
                                    <li>Right-click "This PC" and select "Properties"</li>
                                    <li>Click "Advanced system settings"</li>
                                    <li>Under "Startup and Recovery," click "Settings"</li>
                                    <li>Check the "Write debugging information" dropdown</li>
                                </ol>
                                
                                <div className="alert alert-warning">
                                    <strong>No dump files?</strong> Make sure Windows is configured to create dump files. 
                                    Select "Small memory dump" or "Kernel memory dump" in the Startup and Recovery settings.
                                </div>
                            </section>

                            {/* Using the Analyzer */}
                            <section id="using-analyzer" className="docs-section">
                                <h2>Using the Analyzer</h2>
                                
                                <h3>Step 1: Prepare Your Files</h3>
                                <p>Supported formats:</p>
                                <ul>
                                    <li>.dmp files (any type of Windows dump)</li>
                                    <li>.zip archives containing .dmp files</li>
                                    <li>Multiple files can be analyzed in one session</li>
                                </ul>
                                
                                <h3>Step 2: Upload and Analyze</h3>
                                <ol className="step-list">
                                    <li>Navigate to the <Link to="/analyzer">Analyzer page</Link></li>
                                    <li>Drag and drop your files or click to browse</li>
                                    <li>Click "Analyze" to start the AI analysis</li>
                                    <li>Wait for results (usually 10-30 seconds)</li>
                                </ol>
                                
                                <div className="code-block">
                                    <strong>Tip:</strong> You can analyze multiple dump files at once to identify patterns 
                                    or recurring issues across different crashes.
                                </div>
                            </section>

                            {/* Analysis Results */}
                            <section id="analysis-results" className="docs-section">
                                <h2>Understanding Analysis Results</h2>
                                
                                <p>Each analysis report includes:</p>
                                
                                <h3>Summary Section</h3>
                                <ul>
                                    <li><strong>Plain Language Explanation:</strong> What happened in simple terms</li>
                                    <li><strong>Severity Level:</strong> Critical, High, Medium, or Low</li>
                                    <li><strong>Crash Type:</strong> Driver, Hardware, System, or Application</li>
                                </ul>
                                
                                <h3>Technical Details</h3>
                                <ul>
                                    <li><strong>Stop Code:</strong> The specific BSOD error code</li>
                                    <li><strong>Probable Cause:</strong> Most likely reason for the crash</li>
                                    <li><strong>Culprit:</strong> Specific driver or component responsible</li>
                                    <li><strong>Call Stack:</strong> Function calls leading to the crash</li>
                                </ul>
                                
                                <h3>Recommendations</h3>
                                <p>
                                    Step-by-step solutions tailored to your specific crash, including driver updates, 
                                    hardware tests, and system configuration changes.
                                </p>
                            </section>

                            {/* Ad placement */}
                            <HorizontalAd 
                                className="ad-inline"
                                style={{ margin: '3rem 0' }}
                            />

                            {/* Common Errors */}
                            <section id="common-errors" className="docs-section">
                                <h2>Common BSOD Error Codes</h2>
                                
                                <div className="error-codes">
                                    <div className="error-code">
                                        <h4>IRQL_NOT_LESS_OR_EQUAL (0x0000000A)</h4>
                                        <p>Usually indicates a driver attempting to access memory at an invalid IRQL level. 
                                        Often caused by faulty drivers or hardware issues.</p>
                                        <p><strong>Common fixes:</strong> Update drivers, test RAM, check for overheating</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>PAGE_FAULT_IN_NONPAGED_AREA (0x00000050)</h4>
                                        <p>System tried to access non-existent memory. Can be caused by faulty RAM, 
                                        corrupted drivers, or antivirus software.</p>
                                        <p><strong>Common fixes:</strong> Run memory diagnostic, update/remove antivirus, check drivers</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>SYSTEM_SERVICE_EXCEPTION (0x0000003B)</h4>
                                        <p>Exception occurred while executing a system service routine. Often related to 
                                        graphics drivers or system file corruption.</p>
                                        <p><strong>Common fixes:</strong> Update GPU drivers, run SFC scan, check for Windows updates</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>KERNEL_SECURITY_CHECK_FAILURE (0x00000139)</h4>
                                        <p>Kernel detected corruption in a critical data structure. Usually indicates 
                                        driver issues or memory corruption.</p>
                                        <p><strong>Common fixes:</strong> Update all drivers, check disk health, test RAM</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>CRITICAL_PROCESS_DIED (0x000000EF)</h4>
                                        <p>A critical system process terminated unexpectedly. Can be caused by system 
                                        file corruption or incompatible software.</p>
                                        <p><strong>Common fixes:</strong> Run DISM and SFC, check for malware, boot in safe mode</p>
                                    </div>
                                </div>
                            </section>

                            {/* Advanced Analysis */}
                            <section id="advanced-analysis" className="docs-section">
                                <h2>Advanced Analysis Tools</h2>
                                
                                <p>
                                    After initial analysis, you can run additional debugging commands for deeper insights:
                                </p>
                                
                                <div className="command-list">
                                    <div className="command">
                                        <code>!analyze -v</code>
                                        <p>Provides verbose analysis including stack trace, error details, and follow-up suggestions</p>
                                    </div>
                                    
                                    <div className="command">
                                        <code>lm kv</code>
                                        <p>Lists all kernel modules with version information and timestamps</p>
                                    </div>
                                    
                                    <div className="command">
                                        <code>!process 0 0</code>
                                        <p>Shows process information at the time of crash</p>
                                    </div>
                                    
                                    <div className="command">
                                        <code>!vm</code>
                                        <p>Displays virtual memory usage and statistics</p>
                                    </div>
                                </div>
                                
                                <div className="alert alert-info">
                                    <strong>Pro Tip:</strong> Use these commands when the standard analysis doesn't provide 
                                    enough detail or when investigating complex driver interactions.
                                </div>
                            </section>

                            {/* Troubleshooting */}
                            <section id="troubleshooting" className="docs-section">
                                <h2>Troubleshooting Tips</h2>
                                
                                <h3>Before Analysis</h3>
                                <ul>
                                    <li>Ensure dump files are not corrupted (check file size is greater than 0)</li>
                                    <li>Compress large files into ZIP archives for faster upload</li>
                                    <li>Check that automatic dump creation is enabled in Windows</li>
                                </ul>
                                
                                <h3>Common Solutions</h3>
                                <ol className="step-list">
                                    <li><strong>Update Drivers:</strong> Especially graphics, network, and chipset drivers</li>
                                    <li><strong>Run Memory Test:</strong> Use Windows Memory Diagnostic or MemTest86</li>
                                    <li><strong>Check Disk Health:</strong> Run <code>chkdsk /f /r</code> and check SMART data</li>
                                    <li><strong>System File Check:</strong> Run <code>sfc /scannow</code> and <code>DISM /Online /Cleanup-Image /RestoreHealth</code></li>
                                    <li><strong>Update BIOS:</strong> Check manufacturer's website for updates</li>
                                </ol>
                                
                                <h3>If Problems Persist</h3>
                                <p>
                                    Consider these advanced steps:
                                </p>
                                <ul>
                                    <li>Boot in Safe Mode to isolate driver issues</li>
                                    <li>Use System Restore to revert recent changes</li>
                                    <li>Perform a clean boot to identify software conflicts</li>
                                    <li>Check Event Viewer for additional error details</li>
                                </ul>
                            </section>

                            {/* FAQ */}
                            <section id="faq" className="docs-section">
                                <h2>Frequently Asked Questions</h2>
                                
                                <div className="faq-item">
                                    <h3>Is my dump file data kept private?</h3>
                                    <p>
                                        Yes. We process files locally in your browser and only send extracted text data 
                                        for analysis. We don't store your files or analysis results.
                                    </p>
                                </div>
                                
                                <div className="faq-item">
                                    <h3>Why can't I find any dump files?</h3>
                                    <p>
                                        Windows might not be configured to create dumps. Check your Startup and Recovery 
                                        settings and ensure "Write debugging information" is not set to "None".
                                    </p>
                                </div>
                                
                                <div className="faq-item">
                                    <h3>How accurate is the analysis?</h3>
                                    <p>
                                        Our AI is trained on millions of crash scenarios and typically identifies the root 
                                        cause with high accuracy. However, complex hardware issues may require additional 
                                        diagnostic tools.
                                    </p>
                                </div>
                                
                                <div className="faq-item">
                                    <h3>Can I analyze Linux or macOS crashes?</h3>
                                    <p>
                                        Currently, we only support Windows crash dumps. Support for other operating systems 
                                        is planned for future updates.
                                    </p>
                                </div>
                                
                                <div className="faq-item">
                                    <h3>What if the analyzer can't determine the cause?</h3>
                                    <p>
                                        Try using the advanced analysis tools for more detailed information. If the issue 
                                        persists, the crash might be caused by hardware failure or require professional diagnosis.
                                    </p>
                                </div>
                            </section>
                        </div>
                    </div>
                </div>
            </main>
        </>
    );
};

export default Documentation;