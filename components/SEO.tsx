import React from 'react';
import { Helmet } from 'react-helmet-async';

interface SEOProps {
    title?: string;
    description?: string;
    keywords?: string;
    ogImage?: string;
    ogType?: string;
    canonicalUrl?: string;
}

const SEO: React.FC<SEOProps> = ({
    title = 'BSOD AI Analyzer - Instant Windows Crash Dump Analysis',
    description = 'Free AI-powered Blue Screen of Death analyzer. Upload your Windows crash dump files (.dmp) and get instant diagnosis with actionable solutions. Analyze minidumps and kernel dumps in seconds.',
    keywords = 'BSOD analyzer, blue screen of death, Windows crash dump, minidump analysis, kernel dump, crash analysis, Windows debugging, dump file analyzer, BSOD fix, Windows error',
    ogImage = 'https://bsod.windowsforum.com/og-image.png',
    ogType = 'website',
    canonicalUrl
}) => {
    const siteUrl = 'https://bsod.windowsforum.com';
    const fullTitle = title.includes('BSOD AI Analyzer') ? title : `${title} | BSOD AI Analyzer`;
    
    return (
        <Helmet>
            {/* Basic Meta Tags */}
            <title>{fullTitle}</title>
            <meta name="description" content={description} />
            <meta name="keywords" content={keywords} />
            <meta name="author" content="WindowsForum & Fara Technologies LLC" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <meta name="robots" content="index, follow" />
            <meta name="language" content="English" />
            
            {/* Open Graph Meta Tags */}
            <meta property="og:title" content={fullTitle} />
            <meta property="og:description" content={description} />
            <meta property="og:type" content={ogType} />
            <meta property="og:url" content={canonicalUrl || siteUrl} />
            <meta property="og:image" content={ogImage} />
            <meta property="og:site_name" content="BSOD AI Analyzer" />
            <meta property="og:locale" content="en_US" />
            
            {/* Twitter Card Meta Tags */}
            <meta name="twitter:card" content="summary_large_image" />
            <meta name="twitter:title" content={fullTitle} />
            <meta name="twitter:description" content={description} />
            <meta name="twitter:image" content={ogImage} />
            <meta name="twitter:site" content="@windowsforum" />
            
            {/* Canonical URL */}
            {canonicalUrl && <link rel="canonical" href={canonicalUrl} />}
            
            {/* Additional SEO Tags */}
            <meta name="application-name" content="BSOD AI Analyzer" />
            <meta name="apple-mobile-web-app-title" content="BSOD Analyzer" />
            <meta name="apple-mobile-web-app-capable" content="yes" />
            <meta name="apple-mobile-web-app-status-bar-style" content="black" />
            <meta name="format-detection" content="telephone=no" />
            <meta name="theme-color" content="#0a0a0a" />
        </Helmet>
    );
};

export default SEO;