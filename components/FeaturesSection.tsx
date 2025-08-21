import React from 'react';
import FeatureCard from './FeatureCard';

interface Feature {
    icon: React.ReactNode;
    title: string;
    description: string;
}

interface FeaturesSectionProps {
    title: string;
    subtitle?: string;
    features: Feature[];
    id?: string;
    className?: string;
}

const FeaturesSection: React.FC<FeaturesSectionProps> = ({ 
    title, 
    subtitle, 
    features,
    id,
    className = '' 
}) => {
    return (
        <section id={id} className={`features ${className}`}>
            <div className="container">
                <div style={{ textAlign: 'center' }}>
                    <h2>{title}</h2>
                    {subtitle && (
                        <p style={{ color: 'var(--text-secondary)', maxWidth: '600px', margin: '1rem auto 0' }}>
                            {subtitle}
                        </p>
                    )}
                </div>
                <div className="features-grid">
                    {features.map((feature, index) => (
                        <FeatureCard
                            key={index}
                            icon={feature.icon}
                            title={feature.title}
                            description={feature.description}
                            delay={(index + 1) * 100}
                        />
                    ))}
                </div>
            </div>
        </section>
    );
};

export default FeaturesSection;