import React from 'react';
import SEO from './SEO';

interface PageLayoutProps {
    title: string;
    subtitle?: string;
    description?: string;
    keywords?: string;
    canonicalPath?: string;
    children: React.ReactNode;
    className?: string;
}

const PageLayout: React.FC<PageLayoutProps> = ({ 
    title, 
    subtitle, 
    description, 
    keywords, 
    canonicalPath,
    children,
    className = ''
}) => {
    const pageTitle = `${title} - BSOD AI Analyzer`;
    const canonicalUrl = canonicalPath ? `https://bsod.windowsforum.com${canonicalPath}` : undefined;
    
    return (
        <>
            <SEO 
                title={pageTitle}
                description={description}
                keywords={keywords}
                canonicalUrl={canonicalUrl}
            />
            
            <main className={`page-content ${className}`}>
                <div className="container">
                    <div className="page-header">
                        <h1 className="page-title">{title}</h1>
                        {subtitle && (
                            <p className="page-subtitle">{subtitle}</p>
                        )}
                    </div>
                    
                    {children}
                </div>
            </main>
        </>
    );
};

export default PageLayout;