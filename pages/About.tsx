import React from 'react';
import PageLayout from '../components/PageLayout';
import StructuredData from '../components/StructuredData';
import { MultiplexAd, HorizontalAd, InArticleAd, SquareAd } from '../components/AdSense';
import { DisplayAdSafe } from '../components/AdSenseWithSizeCheck';

const About: React.FC = () => {
    // Article Structured Data
    const articleData = {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": "About BSOD AI Analyzer - Advanced Windows Crash Analysis",
        "description": "Learn how BSOD AI Analyzer uses cutting-edge AI to diagnose Windows crashes",
        "image": "https://bsod.windowsforum.com/og-image.png",
        "datePublished": "2024-01-01T00:00:00+00:00",
        "dateModified": "2024-01-15T00:00:00+00:00",
        "author": {
            "@type": "Organization",
            "name": "WindowsForum",
            "url": "https://windowsforum.com"
        },
        "publisher": {
            "@type": "Organization",
            "name": "Fara Technologies LLC",
            "logo": {
                "@type": "ImageObject",
                "url": "https://windowsforum.com/logo.png"
            }
        },
        "mainEntityOfPage": {
            "@type": "WebPage",
            "@id": "https://bsod.windowsforum.com/about"
        }
    };

    // Service Structured Data
    const serviceData = {
        "@context": "https://schema.org",
        "@type": "Service",
        "serviceType": "Windows Crash Dump Analysis",
        "provider": {
            "@type": "Organization",
            "name": "WindowsForum"
        },
        "areaServed": {
            "@type": "Place",
            "name": "Worldwide"
        },
        "hasOfferCatalog": {
            "@type": "OfferCatalog",
            "name": "BSOD Analysis Services",
            "itemListElement": [
                {
                    "@type": "Offer",
                    "itemOffered": {
                        "@type": "Service",
                        "name": "Minidump Analysis",
                        "description": "AI-powered analysis of Windows minidump files"
                    }
                },
                {
                    "@type": "Offer",
                    "itemOffered": {
                        "@type": "Service",
                        "name": "Kernel Dump Analysis",
                        "description": "Deep analysis of kernel memory dumps"
                    }
                },
                {
                    "@type": "Offer",
                    "itemOffered": {
                        "@type": "Service",
                        "name": "Complete Dump Analysis",
                        "description": "Comprehensive analysis of complete memory dumps"
                    }
                }
            ]
        }
    };

    return (
        <>
            <StructuredData data={articleData} />
            <StructuredData data={serviceData} />
            
            <PageLayout
                title="About BSOD AI Analyzer"
                description="Learn how BSOD AI Analyzer uses advanced artificial intelligence to diagnose Windows crashes. Understand our technology, privacy commitment, and team behind the tool."
                keywords="about BSOD analyzer, how BSOD analysis works, AI crash analysis, Windows debugging technology"
                canonicalPath="/about"
            >
                <div className="content-wrapper">
                    
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
                    
                    {/* Horizontal ad after first section */}
                    <HorizontalAd 
                        className="ad-inline"
                        style={{ margin: '3rem 0' }}
                    />

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
                    
                    {/* In-article ad */}
                    <InArticleAd 
                        className="ad-inline"
                        style={{ margin: '3rem 0' }}
                    />

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
                    
                    {/* Square ad */}
                    <div style={{ display: 'flex', justifyContent: 'center', margin: '3rem 0' }}>
                        <SquareAd 
                            className="ad-square"
                            style={{ maxWidth: '336px' }}
                        />
                    </div>

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
                        <h2>BSOD AI Analyzer vs WinDbg: Comparison</h2>
                        <p>
                            Understanding the differences between our AI-powered approach and traditional debugging tools 
                            helps you choose the right tool for your needs.
                        </p>
                        
                        <div className="comparison-table">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Feature</th>
                                        <th>BSOD AI Analyzer</th>
                                        <th>WinDbg</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr>
                                        <td><strong>Ease of Use</strong></td>
                                        <td>✅ Simple web interface, no installation required</td>
                                        <td>❌ Complex CLI/GUI, requires installation and setup</td>
                                    </tr>
                                    <tr>
                                        <td><strong>Learning Curve</strong></td>
                                        <td>✅ Minimal - designed for all skill levels</td>
                                        <td>❌ Steep - requires debugging knowledge</td>
                                    </tr>
                                    <tr>
                                        <td><strong>Analysis Speed</strong></td>
                                        <td>✅ Instant AI-powered results</td>
                                        <td>⚠️ Manual analysis can take hours</td>
                                    </tr>
                                    <tr>
                                        <td><strong>Memory Analysis</strong></td>
                                        <td>⚠️ Pattern-based string extraction</td>
                                        <td>✅ Direct memory structure access</td>
                                    </tr>
                                    <tr>
                                        <td><strong>Symbol Resolution</strong></td>
                                        <td>❌ No PDB symbol support</td>
                                        <td>✅ Full Microsoft symbol server integration</td>
                                    </tr>
                                    <tr>
                                        <td><strong>Live Debugging</strong></td>
                                        <td>❌ Post-mortem analysis only</td>
                                        <td>✅ Live kernel and user-mode debugging</td>
                                    </tr>
                                    <tr>
                                        <td><strong>Solution Recommendations</strong></td>
                                        <td>✅ AI-generated actionable solutions</td>
                                        <td>❌ Raw data only, no recommendations</td>
                                    </tr>
                                    <tr>
                                        <td><strong>Cost</strong></td>
                                        <td>✅ Free for everyone</td>
                                        <td>✅ Free but requires Windows SDK</td>
                                    </tr>
                                    <tr>
                                        <td><strong>Platform Support</strong></td>
                                        <td>✅ Any device with a web browser</td>
                                        <td>⚠️ Windows only</td>
                                    </tr>
                                    <tr>
                                        <td><strong>Privacy</strong></td>
                                        <td>✅ Client-side processing, no file storage</td>
                                        <td>✅ Fully local analysis</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <section className="content-section">
                        <h2>How to Use WinDbg for Minidump Analysis</h2>
                        <p>
                            For those interested in traditional debugging methods, here's a guide to analyzing minidumps with WinDbg:
                        </p>
                        
                        <h3>1. Installation</h3>
                        <ol>
                            <li>Download Windows SDK or WinDbg Preview from Microsoft Store</li>
                            <li>Install with debugging tools option selected</li>
                            <li>Configure symbol path: <code>.sympath srv*c:\symbols*https://msdl.microsoft.com/download/symbols</code></li>
                        </ol>
                        
                        <h3>2. Opening a Dump File</h3>
                        <pre className="code-block">
windbg -z C:\Windows\Minidump\dump.dmp
</pre>
                        
                        <h3>3. Basic Analysis Commands</h3>
                        <pre className="code-block">
!analyze -v          # Automated crash analysis
lm                   # List loaded modules
!process 0 0         # Show process information
kb                   # Display stack backtrace
.bugcheck           # Show bug check code
!thread             # Current thread information
!drivers            # List all drivers
</pre>
                        
                        <h3>4. Advanced Analysis</h3>
                        <ul>
                            <li><strong>Memory examination:</strong> <code>dd</code>, <code>dq</code>, <code>db</code> commands</li>
                            <li><strong>Structure analysis:</strong> <code>dt</code> command with type information</li>
                            <li><strong>Driver verification:</strong> <code>!verifier</code> for driver verifier data</li>
                            <li><strong>Pool tracking:</strong> <code>!pool</code> for memory pool analysis</li>
                        </ul>
                    </section>

                    <section className="content-section">
                        <h2>Pros and Cons: Choosing the Right Tool</h2>
                        
                        <h3>BSOD AI Analyzer - Best For:</h3>
                        <div className="pros-cons">
                            <div className="pros">
                                <h4>✅ Pros:</h4>
                                <ul>
                                    <li>No technical expertise required</li>
                                    <li>Instant analysis with actionable solutions</li>
                                    <li>Works on any device with internet</li>
                                    <li>Plain-language explanations</li>
                                    <li>Automated pattern recognition</li>
                                    <li>Free and accessible to everyone</li>
                                </ul>
                            </div>
                            <div className="cons">
                                <h4>❌ Cons:</h4>
                                <ul>
                                    <li>Cannot access raw memory structures</li>
                                    <li>No symbol resolution capabilities</li>
                                    <li>Limited to pattern-based analysis</li>
                                    <li>Cannot perform live debugging</li>
                                    <li>Requires internet connection</li>
                                </ul>
                            </div>
                        </div>
                        
                        <h3>WinDbg - Best For:</h3>
                        <div className="pros-cons">
                            <div className="pros">
                                <h4>✅ Pros:</h4>
                                <ul>
                                    <li>Complete memory access and control</li>
                                    <li>Full symbol resolution support</li>
                                    <li>Live kernel debugging capabilities</li>
                                    <li>Scriptable and extensible</li>
                                    <li>Industry-standard tool</li>
                                    <li>Works offline</li>
                                </ul>
                            </div>
                            <div className="cons">
                                <h4>❌ Cons:</h4>
                                <ul>
                                    <li>Steep learning curve</li>
                                    <li>Requires debugging expertise</li>
                                    <li>Time-consuming manual analysis</li>
                                    <li>No automated solutions</li>
                                    <li>Windows-only tool</li>
                                    <li>Complex setup and configuration</li>
                                </ul>
                            </div>
                        </div>
                        
                        <div className="recommendation-box">
                            <h4>Our Recommendation:</h4>
                            <p>
                                <strong>For most users:</strong> Start with BSOD AI Analyzer for quick diagnosis and solutions. 
                                It handles 90% of common crash scenarios effectively.
                            </p>
                            <p>
                                <strong>For IT professionals:</strong> Use BSOD AI Analyzer for initial triage, then dive into 
                                WinDbg if you need deeper hardware-level analysis or are developing drivers.
                            </p>
                        </div>
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

                    <section className="content-section">
                        <h2>Additional Resources</h2>
                        <p>
                            For comprehensive Windows crash troubleshooting guidance, we recommend these official resources:
                        </p>
                        <ul>
                            <li>
                                <a 
                                    href="https://support.microsoft.com/en-us/windows/troubleshooting-windows-unexpected-restarts-and-stop-code-errors-60b01860-58f2-be66-7516-5c45a66ae3c6"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ fontWeight: 500 }}
                                >
                                    Microsoft: Troubleshooting Windows unexpected restarts and stop code errors
                                </a>
                                {' '}- Official Microsoft guide covering common BSOD causes, stop codes, and step-by-step solutions
                            </li>
                            <li>
                                <a 
                                    href="https://windowsforum.com/forums/windows-crashes-bsod-hangs.15/"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ fontWeight: 500 }}
                                >
                                    WindowsForum BSOD Help Community
                                </a>
                                {' '}- Get personalized help from experienced volunteers and Windows experts
                            </li>
                        </ul>
                        <p style={{ marginTop: '1rem' }}>
                            These resources complement our AI analysis by providing broader context and community support 
                            for resolving Windows stability issues.
                        </p>
                    </section>
                    
                    {/* Display ad before recommendations */}
                    <DisplayAdSafe 
                        className="ad-footer"
                        style={{ margin: '3rem 0' }}
                        minWidth={300}
                    />

                    {/* Multiplex ad for content recommendations */}
                    <section style={{ marginTop: '3rem' }}>
                        <h3 style={{ textAlign: 'center', marginBottom: '1.5rem', color: 'var(--text-secondary)' }}>
                            Recommended Resources
                        </h3>
                        <MultiplexAd 
                            style={{ minHeight: '300px' }}
                        />
                    </section>
                </div>
            </PageLayout>
        </>
    );
};

export default About;