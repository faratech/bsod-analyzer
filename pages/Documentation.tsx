import React from 'react';

const Documentation: React.FC = () => {
    return (
        <main className="page-content">
            <div className="container">
                <div className="content-wrapper">
                    <h1>Documentation</h1>
                    
                    <section className="content-section">
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

                    <section className="content-section">
                        <h2>Finding Your Dump Files</h2>
                        
                        <h3>Default Locations</h3>
                        <ul>
                            <li>Minidumps: <code>C:\Windows\Minidump\</code></li>
                            <li>Kernel/Complete dumps: <code>C:\Windows\MEMORY.DMP</code></li>
                        </ul>
                        
                        <h3>Checking Dump Settings</h3>
                        <ol>
                            <li>Right-click "This PC" and select "Properties"</li>
                            <li>Click "Advanced system settings"</li>
                            <li>Under "Startup and Recovery," click "Settings"</li>
                            <li>Check the "Write debugging information" dropdown</li>
                        </ol>
                    </section>

                    <section className="content-section">
                        <h2>Common BSOD Error Codes</h2>
                        
                        <div className="error-codes">
                            <div className="error-code">
                                <h4>IRQL_NOT_LESS_OR_EQUAL (0x0000000A)</h4>
                                <p>Usually indicates a driver attempting to access memory at an invalid IRQL level. 
                                Often caused by faulty drivers or hardware issues.</p>
                            </div>
                            
                            <div className="error-code">
                                <h4>PAGE_FAULT_IN_NONPAGED_AREA (0x00000050)</h4>
                                <p>System tried to access non-existent memory. Can be caused by faulty RAM, 
                                corrupted drivers, or antivirus software.</p>
                            </div>
                            
                            <div className="error-code">
                                <h4>SYSTEM_SERVICE_EXCEPTION (0x0000003B)</h4>
                                <p>Exception occurred while executing a system service routine. Often related to 
                                graphics drivers or system file corruption.</p>
                            </div>
                            
                            <div className="error-code">
                                <h4>KERNEL_SECURITY_CHECK_FAILURE (0x00000139)</h4>
                                <p>Kernel detected corruption in a critical data structure. Usually indicates 
                                driver issues or memory corruption.</p>
                            </div>
                            
                            <div className="error-code">
                                <h4>CRITICAL_PROCESS_DIED (0x000000EF)</h4>
                                <p>A critical system process terminated unexpectedly. Can be caused by system 
                                file corruption or incompatible software.</p>
                            </div>
                        </div>
                    </section>

                    <section className="content-section">
                        <h2>Using the Analyzer</h2>
                        
                        <h3>Step 1: Prepare Your Files</h3>
                        <p>Supported formats:</p>
                        <ul>
                            <li>.dmp files (any type of Windows dump)</li>
                            <li>.zip archives containing .dmp files</li>
                            <li>Multiple files can be analyzed in one session</li>
                        </ul>
                        
                        <h3>Step 2: Upload and Analyze</h3>
                        <ol>
                            <li>Navigate to the Analyzer page</li>
                            <li>Drag and drop your files or click to browse</li>
                            <li>Click "Analyze" to start the AI analysis</li>
                            <li>Wait for results (usually 10-30 seconds)</li>
                        </ol>
                        
                        <h3>Step 3: Understanding Results</h3>
                        <p>Each analysis report includes:</p>
                        <ul>
                            <li><strong>Summary:</strong> Plain-language explanation of the crash</li>
                            <li><strong>Probable Cause:</strong> Most likely reason for the BSOD</li>
                            <li><strong>Culprit:</strong> Specific driver or component responsible</li>
                            <li><strong>Recommendations:</strong> Step-by-step fixes</li>
                            <li><strong>Advanced Analysis:</strong> Technical details for IT professionals</li>
                        </ul>
                    </section>

                    <section className="content-section">
                        <h2>Troubleshooting Tips</h2>
                        
                        <h3>Before Analysis</h3>
                        <ul>
                            <li>Ensure dump files are not corrupted (check file size > 0)</li>
                            <li>Compress large files into ZIP archives for faster upload</li>
                            <li>Check that automatic dump creation is enabled in Windows</li>
                        </ul>
                        
                        <h3>Common Solutions</h3>
                        <ol>
                            <li><strong>Update Drivers:</strong> Especially graphics, network, and chipset drivers</li>
                            <li><strong>Run Memory Test:</strong> Use Windows Memory Diagnostic or MemTest86</li>
                            <li><strong>Check Disk Health:</strong> Run <code>chkdsk /f /r</code> and check SMART data</li>
                            <li><strong>System File Check:</strong> Run <code>sfc /scannow</code> and <code>DISM /Online /Cleanup-Image /RestoreHealth</code></li>
                            <li><strong>Update BIOS:</strong> Check manufacturer's website for updates</li>
                        </ol>
                    </section>

                    <section className="content-section">
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
                    </section>
                </div>
            </div>
        </main>
    );
};

export default Documentation;