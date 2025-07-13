import React from 'react';

const About: React.FC = () => {
    return (
        <main className="page-content">
            <div className="container">
                <div className="content-wrapper">
                    <h1>About BSOD AI Analyzer</h1>
                    
                    <section className="content-section">
                        <h2>Our Mission</h2>
                        <p>
                            BSOD AI Analyzer was created to democratize Windows crash analysis. What once required 
                            deep technical expertise and expensive debugging tools is now available to everyone 
                            through the power of artificial intelligence.
                        </p>
                        <p>
                            We believe that understanding why your computer crashed shouldn't require a computer 
                            science degree. Our AI translates complex technical information into clear, actionable 
                            insights that anyone can understand and implement.
                        </p>
                    </section>

                    <section className="content-section">
                        <h2>How Our AI Works</h2>
                        <p>
                            Our analysis engine uses Google's Gemini AI, trained on millions of crash scenarios 
                            and debugging patterns. When you upload a dump file, our system:
                        </p>
                        <ol>
                            <li>
                                <strong>Extracts Critical Data:</strong> We parse the binary dump file to extract 
                                error codes, driver information, call stacks, and system state data.
                            </li>
                            <li>
                                <strong>Pattern Recognition:</strong> Our AI compares your crash signature against 
                                known patterns to identify the most likely causes.
                            </li>
                            <li>
                                <strong>Contextual Analysis:</strong> The system considers driver versions, hardware 
                                configurations, and recent system changes to provide context-aware recommendations.
                            </li>
                            <li>
                                <strong>Solution Generation:</strong> Based on the analysis, we generate step-by-step 
                                solutions tailored to your specific issue.
                            </li>
                        </ol>
                    </section>

                    <section className="content-section">
                        <h2>Privacy & Security</h2>
                        <p>
                            Your privacy is our priority. Here's how we protect your data:
                        </p>
                        <ul>
                            <li>All dump file processing happens locally in your browser</li>
                            <li>Only extracted text data is sent to our AI for analysis</li>
                            <li>We don't store your dump files or analysis results</li>
                            <li>All communications are encrypted using industry-standard SSL/TLS</li>
                            <li>No personal information is collected or retained</li>
                        </ul>
                    </section>

                    <section className="content-section">
                        <h2>The Team</h2>
                        <p>
                            BSOD AI Analyzer is developed by Fara Technologies LLC in partnership with WindowsForum, 
                            one of the internet's oldest and most trusted Windows support communities. Our team combines:
                        </p>
                        <ul>
                            <li>20+ years of Windows debugging expertise</li>
                            <li>Advanced AI and machine learning capabilities</li>
                            <li>A passion for making technology accessible to everyone</li>
                        </ul>
                    </section>

                    <section className="content-section">
                        <h2>Advanced Features</h2>
                        <p>
                            For power users and IT professionals, we offer advanced analysis tools that mimic 
                            professional debugging commands:
                        </p>
                        <ul>
                            <li><code>!analyze -v</code> - Detailed crash analysis with full technical details</li>
                            <li><code>lm kv</code> - List all loaded kernel modules with version information</li>
                            <li><code>!process 0 0</code> - Display process information at crash time</li>
                            <li><code>!vm</code> - Virtual memory statistics and usage</li>
                        </ul>
                        <p>
                            These tools provide WinDbg-style output for professionals who need deeper insights.
                        </p>
                    </section>

                    <section className="content-section">
                        <h2>Future Development</h2>
                        <p>
                            We're constantly improving our analysis capabilities. Upcoming features include:
                        </p>
                        <ul>
                            <li>Historical crash pattern analysis</li>
                            <li>Predictive failure detection</li>
                            <li>Integration with Windows Event Logs</li>
                            <li>Support for Linux kernel dumps</li>
                            <li>API access for enterprise customers</li>
                        </ul>
                    </section>
                </div>
            </div>
        </main>
    );
};

export default About;