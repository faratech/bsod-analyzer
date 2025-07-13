import React from 'react';
import { Link } from 'react-router-dom';
import { UploadFeatureIcon, AnalyzeFeatureIcon, ResolveFeatureIcon } from '../components/Icons';
import SEO from '../components/SEO';
import AnimatedBackground from '../components/AnimatedBackground';
import StructuredData from '../components/StructuredData';

const Home: React.FC = () => {
    // SoftwareApplication Structured Data
    const softwareData = {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": "BSOD AI Analyzer",
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Web Browser",
        "url": "https://bsod.windowsforum.com",
        "description": "Free AI-powered Blue Screen of Death analyzer for Windows crash dump analysis",
        "screenshot": "https://bsod.windowsforum.com/screenshot.png",
        "datePublished": "2024-01-01",
        "dateModified": "2024-01-15",
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
            "url": "https://windowsforum.com/contact"
        }
    };

    return (
        <>
            <SEO 
                canonicalUrl="https://bsod.windowsforum.com/"
            />
            <StructuredData data={softwareData} />
            <StructuredData data={orgData} />
            <section className="hero">
                <AnimatedBackground />
                <div className="container">
                    <div className="hero-content fade-in">
                        <h1 className="hero-title">Decode Your Blue Screen of Death</h1>
                        <p className="hero-subtitle">
                            Professional-grade Windows crash dump analysis powered by AI. 
                            Get instant insights into what caused your system crash and how to fix it.
                        </p>
                        <div className="hero-actions">
                            <Link to="/analyzer" className="btn btn-primary btn-large glow-button">
                                <span>Start Analysis</span>
                                <span className="btn-sparkle">✨</span>
                            </Link>
                            <Link to="/documentation" className="btn btn-secondary btn-large">
                                Learn More
                            </Link>
                        </div>
                    </div>
                </div>
            </section>

            <section className="features">
                <div className="container">
                    <div style={{ textAlign: 'center' }}>
                        <h2>Why Choose BSOD AI Analyzer?</h2>
                        <p style={{ color: 'var(--text-secondary)', maxWidth: '600px', margin: '1rem auto 0' }}>
                            Advanced AI technology meets Windows debugging expertise
                        </p>
                    </div>
                    <div className="features-grid">
                        <div className="feature-card fade-in" style={{animationDelay: '100ms'}}>
                            <UploadFeatureIcon className="feature-icon" />
                            <h3 className="feature-title">Easy Upload</h3>
                            <p className="feature-description">
                                Simply drag and drop your .dmp files or .zip archives. 
                                Supports both minidumps and kernel dumps.
                            </p>
                        </div>
                        <div className="feature-card fade-in" style={{animationDelay: '200ms'}}>
                            <AnalyzeFeatureIcon className="feature-icon" />
                            <h3 className="feature-title">AI-Powered Analysis</h3>
                            <p className="feature-description">
                                Our AI analyzes crash patterns, driver conflicts, and system states 
                                to pinpoint the exact cause of your BSOD.
                            </p>
                        </div>
                        <div className="feature-card fade-in" style={{animationDelay: '300ms'}}>
                            <ResolveFeatureIcon className="feature-icon" />
                            <h3 className="feature-title">Clear Solutions</h3>
                            <p className="feature-description">
                                Get step-by-step instructions to resolve your specific issue, 
                                from driver updates to system configuration changes.
                            </p>
                        </div>
                    </div>
                </div>
            </section>

            <section className="info-section">
                <div className="container">
                    <div className="info-grid">
                        <div className="info-card">
                            <h3>What is a Blue Screen of Death?</h3>
                            <p>
                                The Blue Screen of Death (BSOD) is Windows' way of protecting your system 
                                when it encounters a critical error. When Windows detects an issue that could 
                                corrupt data or damage hardware, it immediately stops all processes and displays 
                                the blue error screen.
                            </p>
                            <p>
                                Common causes include driver conflicts, hardware failures, corrupted system files, 
                                and incompatible software. Each BSOD generates a memory dump file that contains 
                                crucial information about what went wrong.
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
                </div>
            </section>


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
        </>
    );
};

export default Home;