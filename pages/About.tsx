import React from 'react';
import PageLayout from '../components/PageLayout';
import StructuredData from '../components/StructuredData';
import { MultiplexAd, HorizontalAd, InArticleAd, SquareAd } from '../components/AdSense';
import { DisplayAdSafe } from '../components/AdSenseWithSizeCheck';
import { useActiveSection } from '../hooks/useActiveSection';

const About: React.FC = () => {
    const activeSection = useActiveSection('.about-section');

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
                <div className="docs-layout">
                    <nav className="docs-nav">
                        <h3>Contents</h3>
                        <ul>
                            <li><a href="#mission" className={activeSection === 'mission' ? 'active' : ''}>Our Mission</a></li>
                            <li><a href="#how-it-works" className={activeSection === 'how-it-works' ? 'active' : ''}>How It Works</a></li>
                            <li><a href="#privacy" className={activeSection === 'privacy' ? 'active' : ''}>Privacy & Security</a></li>
                            <li><a href="#team" className={activeSection === 'team' ? 'active' : ''}>The Team</a></li>
                            <li><a href="#features" className={activeSection === 'features' ? 'active' : ''}>Advanced Features</a></li>
                            <li><a href="#comparison" className={activeSection === 'comparison' ? 'active' : ''}>AI vs WinDbg</a></li>
                            <li><a href="#windbg-guide" className={activeSection === 'windbg-guide' ? 'active' : ''}>WinDbg Guide</a></li>
                            <li><a href="#pros-cons" className={activeSection === 'pros-cons' ? 'active' : ''}>Pros and Cons</a></li>
                            <li><a href="#future" className={activeSection === 'future' ? 'active' : ''}>Future Development</a></li>
                            <li><a href="#resources" className={activeSection === 'resources' ? 'active' : ''}>Resources</a></li>
                        </ul>
                    </nav>

                    <div className="docs-content">
                    <section id="mission" className="about-section content-section">
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

                    <section id="how-it-works" className="about-section content-section">
                        <h2>How It Works</h2>
                        <p>
                            Our analyzer combines real WinDBG debugging with Google's Gemini AI to deliver
                            professional-grade crash analysis. When you upload a dump file:
                        </p>
                        <ol>
                            <li>
                                <strong>Real WinDBG Analysis:</strong> Your dump file is securely uploaded to our
                                WinDBG server, which runs actual debugging commands ({<code>!analyze -v</code>})
                                against the crash dump — the same tool Microsoft engineers use.
                            </li>
                            <li>
                                <strong>Symbol Resolution:</strong> The WinDBG server automatically resolves
                                symbols from Microsoft's symbol servers, providing accurate function names,
                                driver versions, and call stacks.
                            </li>
                            <li>
                                <strong>AI Interpretation:</strong> Google's Gemini AI interprets the raw WinDBG
                                output and translates it into a clear, actionable report with plain-language
                                explanations and step-by-step solutions.
                            </li>
                            <li>
                                <strong>Intelligent Caching:</strong> Results are cached by file content hash,
                                so analyzing the same dump again returns instant results.
                            </li>
                        </ol>
                    </section>
                    
                    {/* In-article ad */}
                    <InArticleAd 
                        className="ad-inline"
                        style={{ margin: '3rem 0' }}
                    />

                    <section id="privacy" className="about-section content-section">
                        <h2>Privacy & Security</h2>
                        <p>
                            Your privacy is our priority. Here's how we protect your data:
                        </p>
                        <ul>
                            <li>Dump files are sent to our secure WinDBG server for analysis and are not retained after processing</li>
                            <li>Analysis results are cached temporarily to speed up repeat queries for the same file</li>
                            <li>All communications are encrypted using industry-standard SSL/TLS</li>
                            <li>No personal information is collected or retained</li>
                            <li>API keys and secrets are stored server-side — never exposed to the browser</li>
                            <li>Sessions are protected with Cloudflare Turnstile and rate limiting</li>
                        </ul>
                    </section>
                    
                    {/* Square ad */}
                    <div style={{ display: 'flex', justifyContent: 'center', margin: '3rem 0' }}>
                        <SquareAd 
                            className="ad-square"
                            style={{ maxWidth: '336px' }}
                        />
                    </div>

                    <section id="team" className="about-section content-section">
                        <h2>The Team</h2>
                        <p>
                            BSOD AI Analyzer is developed by Fara Technologies LLC in partnership with <a href="https://windowsforum.com" target="_blank" rel="noopener noreferrer">WindowsForum</a>,
                            one of the internet's oldest and most trusted Windows support communities. Special thanks to{' '}
                            <a href="https://www.stack-tech.com" target="_blank" rel="noopener noreferrer">Stack-Tech</a> for providing additional compute resources. Our team combines:
                        </p>
                        <ul>
                            <li>20+ years of Windows debugging expertise</li>
                            <li>Advanced AI and machine learning capabilities</li>
                            <li>A passion for making technology accessible to everyone</li>
                        </ul>
                    </section>

                    <section id="features" className="about-section content-section">
                        <h2>Advanced Features</h2>
                        <p>
                            Our analyzer runs real WinDBG debugging commands on your crash dump server-side.
                            The output you see comes directly from WinDBG — not a simulation:
                        </p>
                        <ul>
                            <li><code>!analyze -v</code> - Full automated crash analysis with stack traces and module info</li>
                            <li><code>lm kv</code> - List all loaded kernel modules with version information</li>
                            <li><code>!process 0 0</code> - Display process information at crash time</li>
                            <li><code>!vm</code> - Virtual memory statistics and usage</li>
                        </ul>
                        <p>
                            The raw WinDBG output is then interpreted by our AI into a user-friendly report
                            with plain-language explanations and actionable recommendations.
                        </p>
                    </section>

                    <section id="comparison" className="about-section content-section">
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
                                        <td>✅ Server-side WinDBG analysis of full dump</td>
                                        <td>✅ Direct memory structure access</td>
                                    </tr>
                                    <tr>
                                        <td><strong>Symbol Resolution</strong></td>
                                        <td>✅ Automatic via server-side WinDBG</td>
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
                                        <td>✅ Secure server-side processing, no permanent file storage</td>
                                        <td>✅ Fully local analysis</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <section id="windbg-guide" className="about-section content-section">
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

                    <section id="pros-cons" className="about-section content-section">
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
                                    <li>Cannot perform live debugging</li>
                                    <li>Requires internet connection</li>
                                    <li>No interactive command-line session</li>
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

                    <section id="future" className="about-section content-section">
                        <h2>Future Development</h2>
                        <p>
                            We're constantly improving our analysis capabilities. Upcoming features include:
                        </p>
                        <ul>
                            <li>Historical crash pattern analysis</li>
                            <li>Predictive failure detection</li>
                            <li>Integration with Windows Event Logs</li>
                            <li>Support for Linux kernel dumps</li>
                        </ul>
                    </section>

                    <section id="resources" className="about-section content-section">
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
                </div>
            </PageLayout>
        </>
    );
};

export default About;