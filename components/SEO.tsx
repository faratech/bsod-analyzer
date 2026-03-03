import React from 'react';
import { useLocation } from 'react-router-dom';

interface SEOProps {
    title?: string;
    description?: string;
    keywords?: string;
    ogImage?: string;
    ogImageWidth?: number;
    ogImageHeight?: number;
    ogType?: string;
    canonicalUrl?: string;
    noindex?: boolean;
}

const SITE_URL = 'https://bsod.windowsforum.com';

const SEO: React.FC<SEOProps> = ({
    title = 'BSOD AI Analyzer - Instant Windows Crash Dump Analysis',
    description = 'Free AI-powered Blue/Black Screen of Death analyzer. Upload your Windows crash dump files (.dmp) and get instant diagnosis with actionable solutions. Analyzes both classic blue and modern black crash screens.',
    keywords = 'BSOD analyzer, blue screen of death, Windows crash dump, minidump analysis, kernel dump, crash analysis, Windows debugging, dump file analyzer, BSOD fix, Windows error',
    ogImage = `${SITE_URL}/og-image.webp`,
    ogImageWidth = 1200,
    ogImageHeight = 630,
    ogType = 'website',
    canonicalUrl,
    noindex = false
}) => {
    const location = useLocation();
    const fullTitle = title.includes('BSOD AI Analyzer') ? title : `${title} | BSOD AI Analyzer`;
    const resolvedCanonical = canonicalUrl || `${SITE_URL}${location.pathname}`;

    // React 19 automatically hoists these meta tags to the <head>
    return (
        <>
            {/* Basic Meta Tags */}
            <title>{fullTitle}</title>
            <meta name="description" content={description} />
            <meta name="keywords" content={keywords} />
            <meta name="author" content="WindowsForum & Fara Technologies LLC" />
            <meta name="robots" content={noindex ? 'noindex, nofollow' : 'index, follow'} />
            <meta name="language" content="English" />

            {/* Open Graph Meta Tags */}
            <meta property="og:title" content={fullTitle} />
            <meta property="og:description" content={description} />
            <meta property="og:type" content={ogType} />
            <meta property="og:url" content={resolvedCanonical} />
            <meta property="og:image" content={ogImage} />
            <meta property="og:image:width" content={String(ogImageWidth)} />
            <meta property="og:image:height" content={String(ogImageHeight)} />
            <meta property="og:site_name" content="BSOD AI Analyzer" />
            <meta property="og:locale" content="en_US" />

            {/* Twitter Card Meta Tags */}
            <meta name="twitter:card" content="summary_large_image" />
            <meta name="twitter:title" content={fullTitle} />
            <meta name="twitter:description" content={description} />
            <meta name="twitter:image" content={ogImage} />
            <meta name="twitter:site" content="@windowsforum" />

            {/* Canonical URL */}
            <link rel="canonical" href={resolvedCanonical} />

            {/* Additional SEO Tags */}
            <meta name="application-name" content="BSOD AI Analyzer" />
            <meta name="apple-mobile-web-app-title" content="BSOD Analyzer" />
            <meta name="mobile-web-app-capable" content="yes" />
            <meta name="apple-mobile-web-app-status-bar-style" content="black" />
            <meta name="format-detection" content="telephone=no" />
            <meta name="theme-color" content="#0a0a0a" />
        </>
    );
};

export default SEO;
