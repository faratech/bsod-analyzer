import React from 'react';

const ComparisonSection: React.FC = () => {
    return (
        <section className="comparison-section">
            <div className="container">
                <h2>See the Difference</h2>
                <p className="section-subtitle">
                    Compare our user-friendly analysis with traditional debugging tools
                </p>
                
                <div className="comparison-wrapper">
                    <div className="comparison-image-container">
                        <img
                            src="/images/comparison-windbg.webp"
                            alt="Side-by-side comparison of BSOD Analyzer vs WinDbg showing the same crash analysis"
                            loading="lazy"
                            width={1656}
                            height={428}
                            className="comparison-image"
                        />
                    </div>
                    
                    <div className="comparison-features">
                        <div className="comparison-column">
                            <h3>✅ BSOD Analyzer</h3>
                            <ul>
                                <li>Plain English explanations</li>
                                <li>Instant root cause identification</li>
                                <li>Actionable recommendations</li>
                                <li>No technical expertise required</li>
                                <li>Clean, modern interface</li>
                            </ul>
                        </div>
                        
                        <div className="comparison-column">
                            <h3>❌ Traditional Debuggers</h3>
                            <ul>
                                <li>Complex hex dumps</li>
                                <li>Requires kernel debugging knowledge</li>
                                <li>Technical jargon and memory addresses</li>
                                <li>Steep learning curve</li>
                                <li>Command-line interface</li>
                            </ul>
                        </div>
                    </div>
                    
                    <div className="comparison-caption">
                        <p>
                            <strong>Same crash dump, different experience:</strong> While WinDbg shows raw memory 
                            addresses and hex values, BSOD Analyzer tells you exactly what happened and how to fix it. Works with both classic blue and modern black crash screens.
                        </p>
                    </div>
                </div>
            </div>
        </section>
    );
};

export default ComparisonSection;