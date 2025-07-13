import React from 'react';

interface SectionProps {
    id?: string;
    title?: string;
    subtitle?: string;
    className?: string;
    children: React.ReactNode;
    centered?: boolean;
}

const Section: React.FC<SectionProps> = ({ 
    id, 
    title, 
    subtitle, 
    className = '', 
    children,
    centered = false 
}) => {
    return (
        <section id={id} className={`section ${className}`}>
            <div className="container">
                {(title || subtitle) && (
                    <div className={`section-header ${centered ? 'text-center' : ''}`}>
                        {title && <h2>{title}</h2>}
                        {subtitle && (
                            <p className="section-subtitle">
                                {subtitle}
                            </p>
                        )}
                    </div>
                )}
                {children}
            </div>
        </section>
    );
};

export default Section;