import React from 'react';
import HeroAnimation from './HeroAnimation';
import AnimatedBackground from './AnimatedBackground';

interface HeroSectionProps {
    title: string;
    subtitle: string;
    backgroundType?: 'animated' | 'grid';
    className?: string;
    children?: React.ReactNode;
    actions?: React.ReactNode;
}

const HeroSection: React.FC<HeroSectionProps> = ({ 
    title, 
    subtitle, 
    backgroundType = 'grid',
    className = '',
    children,
    actions
}) => {
    return (
        <section className={`hero ${className}`}>
            {backgroundType === 'animated' && <AnimatedBackground />}
            {backgroundType === 'grid' && (
                <div className="hero-background">
                    <div className="hero-grid"></div>
                    <HeroAnimation />
                </div>
            )}
            
            <div className="container">
                <div className="hero-content fade-in">
                    <h1 className="hero-title">{title}</h1>
                    <p className="hero-subtitle">{subtitle}</p>
                    
                    {actions && (
                        <div className="hero-actions">
                            {actions}
                        </div>
                    )}
                    
                    {children}
                </div>
            </div>
        </section>
    );
};

export default HeroSection;