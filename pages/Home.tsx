import React from 'react';
import { Link } from 'react-router-dom';
import { UploadFeatureIcon, AnalyzeFeatureIcon, ResolveFeatureIcon } from '../components/Icons';
import SEO from '../components/SEO';
import StructuredData from '../components/StructuredData';
import HeroSection from '../components/HeroSection';
import FeaturesSection from '../components/FeaturesSection';
import { DisplayAd, InFeedAd, HorizontalAd, SquareAd, VerticalMultiplexAd } from '../components/AdSense';

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
                title="Decode Your Blue Screen of Death"
                subtitle="Professional-grade Windows crash dump analysis powered by AI. Get instant insights into what caused your system crash and how to fix it."
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
            <DisplayAd 
                className="ad-header"
                style={{ minHeight: '90px' }}
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