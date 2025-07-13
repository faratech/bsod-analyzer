import React from 'react';
import PageLayout from '../components/PageLayout';
import StructuredData from '../components/StructuredData';
import { MultiplexAd, DisplayAd, HorizontalAd, InArticleAd, SquareAd } from '../components/AdSense';

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
                    
                    {/* Display ad before recommendations */}
                    <DisplayAd 
                        className="ad-footer"
                        style={{ margin: '3rem 0' }}
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