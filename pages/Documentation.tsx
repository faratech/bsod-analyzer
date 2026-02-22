import React, { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import SEO from '../components/SEO';
import StructuredData from '../components/StructuredData';
import { InArticleAd, HorizontalAd } from '../components/AdSense';
import { useActiveSection } from '../hooks/useActiveSection';

const Documentation: React.FC = () => {
    const location = useLocation();
    const activeSection = useActiveSection('.docs-section');

    // Smooth scroll to section on hash change
    useEffect(() => {
        if (location.hash) {
            const element = document.querySelector(location.hash);
            if (element) {
                element.scrollIntoView({ behavior: 'smooth' });
            }
        }
    }, [location]);

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
                    "text": "A memory dump (also called a crash dump) is a snapshot of your computer's memory at the exact moment a Blue or Black Screen of Death occurs. Windows creates these files to help diagnose what caused the system to crash. They contain information about running processes, loaded drivers, and system state. The screen color depends on your Windows version - classic Windows shows blue, while Windows 11 may show black."
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
                    "text": "Simply upload your .dmp file to BSOD AI Analyzer. Your file is sent to our WinDBG server for real debugging, then our AI interprets the results to identify error codes, problematic drivers, call stacks, and provide step-by-step solutions."
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
                                <li><a href="#getting-started" className={activeSection === 'getting-started' ? 'active' : ''}>Getting Started</a></li>
                                <li><a href="#understanding-dumps" className={activeSection === 'understanding-dumps' ? 'active' : ''}>Understanding Dump Files</a></li>
                                <li><a href="#finding-files" className={activeSection === 'finding-files' ? 'active' : ''}>Finding Your Files</a></li>
                                <li><a href="#using-analyzer" className={activeSection === 'using-analyzer' ? 'active' : ''}>Using the Analyzer</a></li>
                                <li><a href="#analysis-results" className={activeSection === 'analysis-results' ? 'active' : ''}>Analysis Results</a></li>
                                <li><a href="#common-errors" className={activeSection === 'common-errors' ? 'active' : ''}>Common BSOD Errors</a></li>
                                <li><a href="#advanced-analysis" className={activeSection === 'advanced-analysis' ? 'active' : ''}>Advanced Analysis</a></li>
                                <li><a href="#prevention-tips" className={activeSection === 'prevention-tips' ? 'active' : ''}>Prevention Tips</a></li>
                                <li><a href="#troubleshooting" className={activeSection === 'troubleshooting' ? 'active' : ''}>Troubleshooting</a></li>
                                <li><a href="#faq" className={activeSection === 'faq' ? 'active' : ''}>FAQ</a></li>
                            </ul>
                        </nav>

                        {/* Documentation Content */}
                        <div className="docs-content">
                            {/* Getting Started */}
                            <section id="getting-started" className="docs-section">
                                <h2>Getting Started</h2>
                                
                                <p>
                                    BSOD AI Analyzer is a free, web-based tool that helps you understand and resolve 
                                    Windows Blue/Black Screen of Death errors. Our AI-powered system analyzes crash dump files 
                                    to identify the root cause and provide actionable solutions. Supports both classic blue screens and Windows 11's modern black screens.
                                </p>
                                
                                <div className="alert alert-info">
                                    <strong>Quick Start:</strong> Simply drag and drop your .dmp file onto the analyzer
                                    page and click "Analyze." Your file is sent to our WinDBG server for real debugging,
                                    then our AI interprets the results into a clear report. Analysis typically takes
                                    30-60 seconds.
                                </div>
                                
                                <h3>What You'll Need</h3>
                                <ul>
                                    <li>A Windows crash dump file (.dmp) - typically found in C:\Windows\Minidump</li>
                                    <li>A modern web browser (Chrome, Firefox, Edge, or Safari)</li>
                                    <li>An internet connection for AI-powered analysis</li>
                                    <li>No installation or technical knowledge required</li>
                                </ul>
                            </section>

                            {/* Understanding Dumps */}
                            <section id="understanding-dumps" className="docs-section">
                                <h2>Understanding Windows Crash Dumps</h2>
                                
                                <h3>What is a Memory Dump?</h3>
                                <p>
                                    A memory dump (also called a crash dump) is a snapshot of your computer's memory 
                                    at the exact moment a Blue or Black Screen of Death occurs. Windows creates these files to 
                                    help diagnose what caused the system to crash. The screen color depends on your Windows version.
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
                                    <li>Right-click "This PC" (or "My Computer") and select "Properties"</li>
                                    <li>Click "Advanced system settings" on the left</li>
                                    <li>Under the "Advanced" tab, in "Startup and Recovery," click "Settings"</li>
                                    <li>Check the "Write debugging information" dropdown - ensure it's not set to "(none)"</li>
                                    <li>Verify the dump file path (usually %SystemRoot%\MEMORY.DMP)</li>
                                    <li>Click OK to save any changes</li>
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
                                    <li>.zip, .7z, and .rar archives containing .dmp files</li>
                                    <li>Multiple files can be analyzed in one session</li>
                                </ul>
                                
                                <h3>Step 2: Upload and Analyze</h3>
                                <ol className="step-list">
                                    <li>Navigate to the <Link to="/analyzer">Analyzer page</Link></li>
                                    <li>Drag and drop your files or click to browse</li>
                                    <li>Click "Analyze" to start the analysis</li>
                                    <li>Your file is uploaded to our WinDBG server for real debugging</li>
                                    <li>Wait for results (typically 30-60 seconds for first analysis, instant for cached files)</li>
                                </ol>
                                
                                <div className="alert alert-success">
                                    <strong>Pro Tip:</strong> You can analyze multiple dump files at once to identify patterns 
                                    or recurring issues across different crashes. This is especially useful for intermittent 
                                    problems or when troubleshooting system instability.
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
                                    Our AI provides personalized, step-by-step solutions tailored to your specific crash:
                                </p>
                                <ul>
                                    <li><strong>Immediate Actions:</strong> Quick fixes you can try right away</li>
                                    <li><strong>Driver Updates:</strong> Specific drivers that need updating with download links</li>
                                    <li><strong>Hardware Tests:</strong> Diagnostics to run if hardware issues are suspected</li>
                                    <li><strong>System Configuration:</strong> Settings changes to prevent future crashes</li>
                                    <li><strong>Follow-up Steps:</strong> Long-term solutions for system stability</li>
                                </ul>
                            </section>

                            {/* Ad placement */}
                            <HorizontalAd 
                                className="ad-inline"
                                style={{ margin: '3rem 0' }}
                            />

                            {/* Common Errors */}
                            <section id="common-errors" className="docs-section">
                                <h2>Common BSOD Error Codes</h2>
                                
                                <p>
                                    Below is a comprehensive list of Windows Blue Screen error codes. Click on any error 
                                    to expand for detailed information and solutions.
                                </p>
                                
                                <h3>Most Frequent Errors</h3>
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
                                    
                                    <div className="error-code">
                                        <h4>DRIVER_VERIFIER_DETECTED_VIOLATION (0x000000C4)</h4>
                                        <p>Driver Verifier detected a driver behaving improperly. This typically occurs when 
                                        testing drivers for compatibility issues.</p>
                                        <p><strong>Common fixes:</strong> Disable Driver Verifier, update problematic drivers, remove recently installed drivers</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>DPC_WATCHDOG_VIOLATION (0x00000133)</h4>
                                        <p>A DPC routine ran too long, indicating a driver compatibility issue. Often related to 
                                        SSD firmware or old drivers.</p>
                                        <p><strong>Common fixes:</strong> Update SSD firmware, check SATA drivers, update chipset drivers</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>SYSTEM_THREAD_EXCEPTION_NOT_HANDLED (0x0000007E)</h4>
                                        <p>A system thread generated an exception that wasn't handled. Usually indicates 
                                        driver or hardware issues.</p>
                                        <p><strong>Common fixes:</strong> Update or rollback recent driver updates, check for hardware issues</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>MEMORY_MANAGEMENT (0x0000001A)</h4>
                                        <p>Severe memory management error. Often caused by faulty RAM, driver issues, or 
                                        software bugs.</p>
                                        <p><strong>Common fixes:</strong> Run Windows Memory Diagnostic, update drivers, check for disk errors</p>
                                    </div>
                                </div>
                                
                                <h3>Driver-Related Errors</h3>
                                <div className="error-codes">
                                    <div className="error-code">
                                        <h4>DRIVER_IRQL_NOT_LESS_OR_EQUAL (0x000000D1)</h4>
                                        <p>A driver attempted to access pageable memory at an inappropriate IRQL. Common with 
                                        network and USB drivers.</p>
                                        <p><strong>Common fixes:</strong> Update network/USB drivers, remove recently installed hardware</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>DRIVER_POWER_STATE_FAILURE (0x0000009F)</h4>
                                        <p>Driver failed to handle power state transition properly. Common during sleep/wake 
                                        cycles.</p>
                                        <p><strong>Common fixes:</strong> Update device drivers, check power settings, disable fast startup</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>DRIVER_OVERRAN_STACK_BUFFER (0x000000F7)</h4>
                                        <p>A driver overflowed a stack-based buffer. Indicates a serious driver bug.</p>
                                        <p><strong>Common fixes:</strong> Identify and update/remove the faulty driver, check for driver updates</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>DRIVER_UNLOADED_WITHOUT_CANCELLING_PENDING_OPERATIONS (0x000000CE)</h4>
                                        <p>A driver unloaded without canceling pending operations. Usually a driver programming error.</p>
                                        <p><strong>Common fixes:</strong> Update the problematic driver, remove recently installed drivers</p>
                                    </div>
                                </div>
                                
                                <h3>Hardware-Related Errors</h3>
                                <div className="error-codes">
                                    <div className="error-code">
                                        <h4>MACHINE_CHECK_EXCEPTION (0x0000009C)</h4>
                                        <p>Fatal hardware error detected by CPU. Often indicates failing CPU, motherboard, or 
                                        power supply.</p>
                                        <p><strong>Common fixes:</strong> Check CPU temperature, test with different PSU, run hardware diagnostics</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>WHEA_UNCORRECTABLE_ERROR (0x00000124)</h4>
                                        <p>Hardware error reported by Windows Hardware Error Architecture. Serious hardware 
                                        problem detected.</p>
                                        <p><strong>Common fixes:</strong> Check all hardware components, update BIOS, check for overheating</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>CLOCK_WATCHDOG_TIMEOUT (0x00000101)</h4>
                                        <p>Processor core didn't respond within allocated time. Multi-core synchronization issue.</p>
                                        <p><strong>Common fixes:</strong> Update BIOS, check CPU cooling, disable overclocking</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>HAL_INITIALIZATION_FAILED (0x0000005C)</h4>
                                        <p>Hardware Abstraction Layer failed to initialize. Often indicates hardware incompatibility.</p>
                                        <p><strong>Common fixes:</strong> Check hardware compatibility, update BIOS, remove incompatible hardware</p>
                                    </div>
                                </div>
                                
                                <h3>File System Errors</h3>
                                <div className="error-codes">
                                    <div className="error-code">
                                        <h4>NTFS_FILE_SYSTEM (0x00000024)</h4>
                                        <p>Problem with the NTFS file system driver. Usually indicates disk corruption or 
                                        failing hard drive.</p>
                                        <p><strong>Common fixes:</strong> Run chkdsk /f /r, check disk health, backup data immediately</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>FAT_FILE_SYSTEM (0x00000023)</h4>
                                        <p>Problem with FAT file system. Common with USB drives or older partitions.</p>
                                        <p><strong>Common fixes:</strong> Run chkdsk on the affected drive, check for disk errors</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>DATA_BUS_ERROR (0x0000002E)</h4>
                                        <p>Parity error in system memory. Usually indicates failing RAM or motherboard issues.</p>
                                        <p><strong>Common fixes:</strong> Test RAM modules individually, check motherboard for damage</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>KERNEL_DATA_INPAGE_ERROR (0x0000007A)</h4>
                                        <p>Kernel couldn't read requested data from pagefile. Often indicates disk or memory issues.</p>
                                        <p><strong>Common fixes:</strong> Check disk health, test RAM, check SATA cables</p>
                                    </div>
                                </div>
                                
                                <h3>Security and System Errors</h3>
                                <div className="error-codes">
                                    <div className="error-code">
                                        <h4>SECURITY_SYSTEM (0x00000029)</h4>
                                        <p>Security system encountered fatal error. Can be caused by security software conflicts.</p>
                                        <p><strong>Common fixes:</strong> Remove conflicting security software, check for malware</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>SYSTEM_LICENSE_VIOLATION (0x0000009A)</h4>
                                        <p>Software license agreement violation detected. Rare error related to system integrity.</p>
                                        <p><strong>Common fixes:</strong> Verify Windows activation, run system file checker</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>ATTEMPTED_EXECUTE_OF_NOEXECUTE_MEMORY (0x000000FC)</h4>
                                        <p>Attempt to execute non-executable memory. Security feature prevented code execution.</p>
                                        <p><strong>Common fixes:</strong> Update drivers, check for malware, verify DEP settings</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>SESSION_HAS_VALID_POOL_ON_EXIT (0x000000AB)</h4>
                                        <p>Session unloaded with pool allocations still active. Indicates driver memory leak.</p>
                                        <p><strong>Common fixes:</strong> Update graphics drivers, check for driver memory leaks</p>
                                    </div>
                                </div>
                                
                                <h3>Boot and Initialization Errors</h3>
                                <div className="error-codes">
                                    <div className="error-code">
                                        <h4>INACCESSIBLE_BOOT_DEVICE (0x0000007B)</h4>
                                        <p>Windows lost access to the boot partition during startup. Common after hardware changes.</p>
                                        <p><strong>Common fixes:</strong> Check BIOS settings, verify boot drive connection, repair boot configuration</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>UNMOUNTABLE_BOOT_VOLUME (0x000000ED)</h4>
                                        <p>Boot volume cannot be mounted. File system or disk controller issues.</p>
                                        <p><strong>Common fixes:</strong> Run startup repair, check disk for errors, verify SATA mode in BIOS</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>BOOT_INITIALIZATION_FAILED (0x0000006B)</h4>
                                        <p>Windows failed to initialize during boot process. Often caused by corrupted system files.</p>
                                        <p><strong>Common fixes:</strong> Use System Restore, run startup repair, check for disk corruption</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>STATUS_SYSTEM_PROCESS_TERMINATED (0x000000C00002E2)</h4>
                                        <p>Critical system process terminated during boot. Severe system file corruption.</p>
                                        <p><strong>Common fixes:</strong> Boot from installation media and repair, restore from backup</p>
                                    </div>
                                </div>
                                
                                <h3>Memory and Resource Errors</h3>
                                <div className="error-codes">
                                    <div className="error-code">
                                        <h4>OUT_OF_MEMORY (0x0000002D)</h4>
                                        <p>System ran out of memory resources. Can occur with memory leaks or insufficient RAM.</p>
                                        <p><strong>Common fixes:</strong> Add more RAM, check for memory leaks, increase pagefile size</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>POOL_CORRUPTION_IN_FILE_AREA (0x000000DE)</h4>
                                        <p>Memory pool corruption detected in file system structures. Driver or hardware issue.</p>
                                        <p><strong>Common fixes:</strong> Update storage drivers, check disk integrity, test RAM</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>BAD_POOL_HEADER (0x00000019)</h4>
                                        <p>Pool header corruption detected. Usually caused by driver bugs or failing RAM.</p>
                                        <p><strong>Common fixes:</strong> Update all drivers, run memory diagnostic, check for overheating</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>PFN_LIST_CORRUPT (0x0000004E)</h4>
                                        <p>Page Frame Number list is corrupted. Serious memory management issue.</p>
                                        <p><strong>Common fixes:</strong> Test RAM thoroughly, update chipset drivers, check motherboard</p>
                                    </div>
                                </div>
                                
                                <h3>Network and Communication Errors</h3>
                                <div className="error-codes">
                                    <div className="error-code">
                                        <h4>TCPIP_AOAC_NIC_ACTIVE_REFERENCE_LEAK (0x00000165)</h4>
                                        <p>Network adapter driver leaked an active reference. Power management issue with network card.</p>
                                        <p><strong>Common fixes:</strong> Update network drivers, disable power saving for network adapter</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>NETWORK_BOOT_INITIALIZATION_FAILED (0x0000006C)</h4>
                                        <p>Network boot failed to initialize. Common in diskless workstation environments.</p>
                                        <p><strong>Common fixes:</strong> Check network boot settings, verify PXE configuration</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>NDIS_INTERNAL_ERROR (0x0000007C)</h4>
                                        <p>Internal error in Network Driver Interface Specification. Network driver problem.</p>
                                        <p><strong>Common fixes:</strong> Update or reinstall network drivers, check for driver conflicts</p>
                                    </div>
                                </div>
                                
                                <h3>USB and External Device Errors</h3>
                                <div className="error-codes">
                                    <div className="error-code">
                                        <h4>BUGCODE_USB_DRIVER (0x000000FE)</h4>
                                        <p>USB driver encountered fatal error. Common with problematic USB devices or hubs.</p>
                                        <p><strong>Common fixes:</strong> Update USB drivers, remove USB devices, check for faulty USB ports</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>USB_DRIPS_BLOCKER_SURPRISE_REMOVAL_LIVEDUMP (0x00000180)</h4>
                                        <p>USB device was surprise-removed while blocking system sleep. Power management issue.</p>
                                        <p><strong>Common fixes:</strong> Safely remove USB devices, update USB controller drivers</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>INVALID_USB_DESCRIPTOR (0x00000166)</h4>
                                        <p>USB device provided invalid descriptor. Faulty or incompatible USB device.</p>
                                        <p><strong>Common fixes:</strong> Remove the problematic USB device, update device firmware</p>
                                    </div>
                                </div>
                                
                                <h3>Graphics and Display Errors</h3>
                                <div className="error-codes">
                                    <div className="error-code">
                                        <h4>VIDEO_TDR_FAILURE (0x00000116)</h4>
                                        <p>Display driver stopped responding and was recovered. GPU timeout detection and recovery.</p>
                                        <p><strong>Common fixes:</strong> Update graphics drivers, check GPU temperature, reduce GPU overclock</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>VIDEO_SCHEDULER_INTERNAL_ERROR (0x00000119)</h4>
                                        <p>Video scheduler encountered fatal error. Graphics subsystem problem.</p>
                                        <p><strong>Common fixes:</strong> Reinstall graphics drivers, check for GPU hardware issues</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>VIDEO_MEMORY_MANAGEMENT_INTERNAL (0x0000010E)</h4>
                                        <p>Video memory manager encountered unrecoverable error. VRAM or driver issue.</p>
                                        <p><strong>Common fixes:</strong> Update GPU drivers, test with different GPU, check VRAM integrity</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>DISPLAY_DRIVER_STOPPED_RESPONDING (0x00000117)</h4>
                                        <p>Display driver stopped responding. Similar to VIDEO_TDR_FAILURE but more severe.</p>
                                        <p><strong>Common fixes:</strong> Clean install graphics drivers, check display cable connections</p>
                                    </div>
                                </div>
                                
                                <h3>Virtualization and Hyper-V Errors</h3>
                                <div className="error-codes">
                                    <div className="error-code">
                                        <h4>HYPERVISOR_ERROR (0x00020001)</h4>
                                        <p>Hyper-V hypervisor encountered fatal error. Virtualization platform issue.</p>
                                        <p><strong>Common fixes:</strong> Update Hyper-V, check virtualization settings in BIOS</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>VMBUS_VIRTUAL_PROCESSOR_LIMIT_EXCEEDED (0x00000151)</h4>
                                        <p>Virtual machine exceeded processor limit. Hyper-V configuration issue.</p>
                                        <p><strong>Common fixes:</strong> Reduce virtual processors, check Hyper-V limits</p>
                                    </div>
                                </div>
                                
                                <h3>Miscellaneous System Errors</h3>
                                <div className="error-codes">
                                    <div className="error-code">
                                        <h4>UNEXPECTED_KERNEL_MODE_TRAP (0x0000007F)</h4>
                                        <p>Kernel encountered unexpected condition. Can be hardware or software related.</p>
                                        <p><strong>Common fixes:</strong> Check for overheating, test RAM, update all drivers</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>KMODE_EXCEPTION_NOT_HANDLED (0x0000001E)</h4>
                                        <p>Kernel-mode program generated exception not handled. Driver or hardware issue.</p>
                                        <p><strong>Common fixes:</strong> Update drivers, check for hardware problems, run system diagnostics</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>REFERENCE_BY_POINTER (0x00000018)</h4>
                                        <p>Object reference count error. Usually indicates driver programming error.</p>
                                        <p><strong>Common fixes:</strong> Update or remove problematic drivers, check for driver conflicts</p>
                                    </div>
                                    
                                    <div className="error-code">
                                        <h4>WORKER_THREAD_RETURNED_AT_BAD_IRQL (0x000000E1)</h4>
                                        <p>Worker thread returned at wrong IRQL. Driver didn't properly restore IRQL.</p>
                                        <p><strong>Common fixes:</strong> Identify and update the faulty driver</p>
                                    </div>
                                </div>
                                
                                <div className="alert alert-info" style={{ marginTop: '2rem' }}>
                                    <strong>Note:</strong> This list covers the most common BSOD errors. Our AI analyzer 
                                    can identify and provide solutions for hundreds of additional error codes not listed here.
                                </div>
                            </section>

                            {/* Advanced Analysis */}
                            <section id="advanced-analysis" className="docs-section">
                                <h2>Advanced Analysis Tools</h2>

                                <p>
                                    Our analyzer runs real WinDBG debugging commands on your crash dump server-side.
                                    The output comes directly from WinDBG — not a simulation. Key commands include:
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
                                
                                
                                <h3>Symbol Resolution</h3>
                                <p>
                                    Our WinDBG server automatically downloads and resolves Windows symbols from
                                    Microsoft's symbol servers, providing accurate function names and call stacks:
                                </p>
                                <ul>
                                    <li>Downloads PDB symbols for the exact Windows version from the crash</li>
                                    <li>Resolves driver and system function names automatically</li>
                                    <li>Provides accurate stack traces with module and offset information</li>
                                    <li>Symbols are cached on the server for faster subsequent analysis</li>
                                </ul>

                                <div className="alert alert-info">
                                    <strong>Pro Tip:</strong> First-time analysis of a dump may take 30-60 seconds
                                    while WinDBG processes the file. If the same file is analyzed again, results are
                                    returned instantly from cache.
                                </div>
                                
                                <h3>Reading Stack Traces</h3>
                                <p>
                                    Stack traces show the sequence of function calls leading to the crash. Our analyzer 
                                    automatically interprets these for you, but understanding the basics can be helpful:
                                </p>
                                <ul>
                                    <li><strong>Top of stack:</strong> The function where the crash occurred</li>
                                    <li><strong>Call sequence:</strong> Each line shows a function that called the one above it</li>
                                    <li><strong>Module names:</strong> Show which driver or system component each function belongs to</li>
                                    <li><strong>Offsets:</strong> Help pinpoint the exact location within a function</li>
                                </ul>
                            </section>

                            {/* Prevention Tips */}
                            <section id="prevention-tips" className="docs-section">
                                <h2>Preventing Future Crashes</h2>
                                
                                <p>
                                    While our analyzer helps fix crashes after they occur, following these best practices 
                                    can help prevent Blue Screens:
                                </p>
                                
                                <h3>Regular Maintenance</h3>
                                <ul>
                                    <li><strong>Keep Windows Updated:</strong> Install updates promptly to fix known issues</li>
                                    <li><strong>Update Drivers Regularly:</strong> Especially graphics, chipset, and storage drivers</li>
                                    <li><strong>Monitor System Health:</strong> Check Event Viewer for warnings before crashes occur</li>
                                    <li><strong>Clean Boot Periodically:</strong> Remove unnecessary startup programs</li>
                                </ul>
                                
                                <h3>Hardware Care</h3>
                                <ul>
                                    <li><strong>Monitor Temperatures:</strong> Ensure proper cooling to prevent thermal issues</li>
                                    <li><strong>Test RAM Periodically:</strong> Run Windows Memory Diagnostic monthly</li>
                                    <li><strong>Check Disk Health:</strong> Use CrystalDiskInfo to monitor SSD/HDD health</li>
                                    <li><strong>Stable Power Supply:</strong> Use a UPS for desktop systems</li>
                                </ul>
                                
                                <h3>Software Best Practices</h3>
                                <ul>
                                    <li><strong>Avoid Beta Drivers:</strong> Stick to stable, WHQL-certified drivers</li>
                                    <li><strong>Uninstall Conflicting Software:</strong> Remove multiple antivirus programs</li>
                                    <li><strong>Create Restore Points:</strong> Before major system changes</li>
                                    <li><strong>Regular Backups:</strong> Protect your data in case of system failure</li>
                                </ul>
                                
                                <div className="alert alert-success">
                                    <strong>Remember:</strong> Most Blue Screens are caused by driver issues. Keeping 
                                    drivers updated is the single most effective prevention method.
                                </div>
                            </section>

                            {/* Troubleshooting */}
                            <section id="troubleshooting" className="docs-section">
                                <h2>Troubleshooting Tips</h2>
                                
                                <h3>Before Analysis</h3>
                                <ul>
                                    <li>Ensure dump files are not corrupted (check file size is greater than 0)</li>
                                    <li>Compress large files into ZIP, 7z, or RAR archives for faster upload</li>
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
                                        Yes. Your dump file is securely uploaded to our WinDBG server for analysis
                                        and is not retained after processing. Analysis results are cached temporarily
                                        to speed up repeat queries. All communications are encrypted via TLS,
                                        and no personal information is collected.
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
                                        Our analyzer runs real WinDBG debugging on your crash dump, producing the same
                                        output a Microsoft engineer would see. The AI then interprets this data to
                                        identify the root cause with high accuracy. However, complex hardware issues
                                        may require additional diagnostic tools.
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
                                
                                <div className="faq-item">
                                    <h3>What's the difference between minidump and kernel dump?</h3>
                                    <p>
                                        <strong>Minidumps</strong> (64KB-2MB) contain essential crash information and are 
                                        sufficient for most crash analysis. <strong>Kernel dumps</strong> (larger, ~1/3 of RAM) 
                                        include all kernel memory and provide more detailed information for complex issues. 
                                        Our analyzer handles both types automatically.
                                    </p>
                                </div>
                                
                                <div className="faq-item">
                                    <h3>How often should I analyze crash dumps?</h3>
                                    <p>
                                        Analyze dumps whenever you experience a Blue Screen. If you have recurring crashes, 
                                        analyze multiple dumps to identify patterns. Regular analysis helps catch driver 
                                        issues before they become critical.
                                    </p>
                                </div>
                                
                                <div className="faq-item">
                                    <h3>Where can I find more information about Windows crashes?</h3>
                                    <p>
                                        For additional resources and community support:
                                    </p>
                                    <ul style={{ marginTop: '0.5rem' }}>
                                        <li>
                                            <a 
                                                href="https://support.microsoft.com/en-us/windows/troubleshooting-windows-unexpected-restarts-and-stop-code-errors-60b01860-58f2-be66-7516-5c45a66ae3c6"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                Microsoft Support: Troubleshooting Windows unexpected restarts and stop code errors
                                            </a>
                                        </li>
                                        <li>
                                            <a 
                                                href="https://windowsforum.com/forums/windows-blue-screen-of-death-bsod.307/"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                WindowsForum BSOD Help Community - Get expert help from the community
                                            </a>
                                        </li>
                                        <li>
                                            <a 
                                                href="https://docs.microsoft.com/en-us/windows-hardware/drivers/debugger/"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                Windows Debugging Documentation - For advanced users
                                            </a>
                                        </li>
                                    </ul>
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