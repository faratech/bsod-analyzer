import React from 'react';
import { Link } from 'react-router-dom';
import { UploadFeatureIcon, AnalyzeFeatureIcon, ResolveFeatureIcon } from '../components/Icons';
import SEO from '../components/SEO';
import StructuredData from '../components/StructuredData';
import HeroSection from '../components/HeroSection';
import FeaturesSection from '../components/FeaturesSection';
import ComparisonSection from '../components/ComparisonSection';
import { InFeedAd, HorizontalAd, SquareAd, VerticalMultiplexAd } from '../components/AdSense';
import { DisplayAdSafe } from '../components/AdSenseWithSizeCheck';

const Home: React.FC = () => {
    // SoftwareApplication Structured Data
    const softwareData = {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": "BSOD AI Analyzer",
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Web Browser",
        "url": "https://bsod.windowsforum.com",
        "description": "Free AI-powered Windows crash analyzer supporting all error screens - blue (BSOD), black (Windows 11 Build 22000.346+), green (Insider), and system freezes. Professional crash dump analysis with instant solutions.",
        "screenshot": "https://bsod.windowsforum.com/screenshot.png",
        "datePublished": "2024-01-01",
        "dateModified": "2025-08-18",
        "author": {
            "@type": "Organization",
            "name": "WindowsForum",
            "url": "https://windowsforum.com"
        },
        "provider": {
            "@type": "Organization",
            "name": "Fara Technologies LLC"
        },
        "offers": {
            "@type": "Offer",
            "price": "0",
            "priceCurrency": "USD"
        },
        "aggregateRating": {
            "@type": "AggregateRating",
            "ratingValue": "4.8",
            "ratingCount": "1250",
            "bestRating": "5",
            "worstRating": "1"
        },
        "featureList": [
            "Instant BSOD analysis",
            "AI-powered diagnostics",
            "Support for all dump file types",
            "Detailed error explanations",
            "Step-by-step solutions",
            "Advanced debugging tools"
        ],
        "softwareRequirements": "Modern web browser with JavaScript enabled",
        "softwareVersion": "2.0"
    };

    // Organization Structured Data
    const orgData = {
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": "WindowsForum",
        "url": "https://windowsforum.com",
        "logo": "https://windowsforum.com/logo.png",
        "description": "Leading Windows support community providing expert help and tools",
        "foundingDate": "2009",
        "sameAs": [
            "https://twitter.com/windowsforum",
            "https://github.com/faratech"
        ],
        "contactPoint": {
            "@type": "ContactPoint",
            "contactType": "Technical Support",
            "email": "admin@windowsforum.com",
            "url": "https://windowsforum.com/misc/contact"
        }
    };

    return (
        <>
            <SEO 
                canonicalUrl="https://bsod.windowsforum.com/"
            />
            <StructuredData data={softwareData} />
            <StructuredData data={orgData} />
            
            <HeroSection
                title="Decode Your Windows Crash Screen"
                subtitle="Professional AI-powered analysis for all Windows crashes - whether you see a blue screen, black screen (Windows 11 Build 22000.346+), green screen (Insider builds), or system freeze. Get instant insights into what caused your crash and how to fix it."
                backgroundType="animated"
                actions={
                    <>
                        <Link to="/analyzer" className="btn btn-primary btn-large glow-button">
                            <span>Start Analysis</span>
                            <span className="btn-sparkle">✨</span>
                        </Link>
                        <Link to="/documentation" className="btn btn-secondary btn-large">
                            Learn More
                        </Link>
                    </>
                }
            />

            {/* Ad after hero section - high visibility */}
            <DisplayAdSafe 
                className="ad-header"
                style={{ minHeight: '90px' }}
                minWidth={300}
            />

            <FeaturesSection
                title="Why Choose BSOD AI Analyzer?"
                subtitle="Advanced AI technology meets Windows debugging expertise"
                features={[
                    {
                        icon: <UploadFeatureIcon />,
                        title: "Easy Upload",
                        description: "Simply drag and drop your .dmp files or .zip archives. Supports both minidumps and kernel dumps."
                    },
                    {
                        icon: <AnalyzeFeatureIcon />,
                        title: "AI-Powered Analysis",
                        description: "Our AI analyzes crash patterns, driver conflicts, and system states to pinpoint the exact cause of your BSOD."
                    },
                    {
                        icon: <ResolveFeatureIcon />,
                        title: "Clear Solutions",
                        description: "Get step-by-step instructions to resolve your specific issue, from driver updates to system configuration changes."
                    }
                ]}
            />

            {/* Horizontal ad between features and info sections */}
            <HorizontalAd 
                className="ad-inline"
                style={{ maxWidth: '1280px', margin: '3rem auto' }}
            />

            <ComparisonSection />

            <section className="info-section">
                <div className="container">
                    <div className="info-grid">
                        <div className="info-card">
                            <h3>Understanding Windows Crash Screens</h3>
                            <p>
                                <strong>Not all crashes show a blue screen!</strong> Depending on your Windows version and settings, 
                                you might encounter different types of critical error screens:
                            </p>
                            <ul style={{ marginTop: '1rem' }}>
                                <li><strong>🔵 Blue Screen (BSOD)</strong> - The classic crash screen in Windows 10 and earlier versions</li>
                                <li><strong>⚫ Black Screen</strong> - Starting with Windows 11 Build 22000.346 and later, the crash screen 
                                is black instead of blue, often followed by automatic repair attempts</li>
                                <li><strong>🟢 Green Screen (GSOD)</strong> - If you've ever enrolled in Windows Insider Preview builds, 
                                crashes display a green screen to differentiate beta issues from regular system crashes</li>
                                <li><strong>❄️ System Freeze</strong> - Sometimes Windows completely freezes without showing any error screen. 
                                The system becomes unresponsive but no crash screen appears</li>
                            </ul>
                            <p style={{ marginTop: '1rem' }}>
                                <em>All these scenarios generate crash dump files that our analyzer can process, regardless of 
                                the screen color or whether a screen appeared at all.</em>
                            </p>
                        </div>
                        <div className="info-card">
                            <h3>How Our Analysis Works</h3>
                            <p>
                                Our AI-powered analyzer examines your crash dump files to identify:
                            </p>
                            <ul>
                                <li>The specific error code and its meaning</li>
                                <li>Which driver or system component caused the crash</li>
                                <li>The exact sequence of events leading to the failure</li>
                                <li>Potential hardware or software conflicts</li>
                            </ul>
                            <p>
                                Using advanced pattern recognition, we provide targeted solutions based on 
                                millions of analyzed crash scenarios.
                            </p>
                        </div>
                    </div>
                    <div className="info-card" style={{ gridColumn: '1 / -1', marginTop: '2rem' }}>
                        <h3>Additional Resources</h3>
                        <p>
                            For more information about Windows crashes and troubleshooting:
                        </p>
                        <ul style={{ marginTop: '1rem' }}>
                            <li>
                                <a 
                                    href="https://support.microsoft.com/en-us/windows/troubleshooting-windows-unexpected-restarts-and-stop-code-errors-60b01860-58f2-be66-7516-5c45a66ae3c6"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ color: 'var(--link-color)', textDecoration: 'underline' }}
                                >
                                    Microsoft Support: Troubleshooting Windows unexpected restarts and stop code errors
                                </a>
                                {' '}- Official guide from Microsoft covering common causes and solutions
                            </li>
                            <li style={{ marginTop: '0.5rem' }}>
                                <Link 
                                    to="/documentation"
                                    style={{ color: 'var(--link-color)', textDecoration: 'underline' }}
                                >
                                    BSOD AI Analyzer Documentation
                                </Link>
                                {' '}- Learn how to use our tool effectively
                            </li>
                        </ul>
                    </div>
                </div>
            </section>

            {/* Square ad before CTA */}
            <div className="container" style={{ marginTop: '3rem', marginBottom: '3rem' }}>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <SquareAd 
                        className="ad-square"
                        style={{ maxWidth: '336px' }}
                    />
                </div>
            </div>

            <section className="cta-section">
                <div className="container">
                    <div className="cta-content">
                        <h2>Ready to Fix Your BSOD?</h2>
                        <p>Upload your crash dump and get answers in seconds</p>
                        <Link to="/analyzer" className="btn btn-primary btn-large">
                            Analyze Your Dump File
                        </Link>
                    </div>
                </div>
            </section>
            
            {/* Vertical Multiplex ad for content recommendations */}
            <section style={{ marginTop: '3rem' }}>
                <div className="container">
                    <h3 style={{ textAlign: 'center', marginBottom: '2rem', fontSize: '1.5rem', color: 'var(--text-secondary)' }}>
                        Recommended Resources
                    </h3>
                    <VerticalMultiplexAd 
                        className="ad-multiplex"
                        style={{ maxWidth: '1280px', margin: '0 auto' }}
                    />
                </div>
            </section>
        </>
    );
};

export default Home;