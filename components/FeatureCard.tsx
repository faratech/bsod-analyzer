import React from 'react';

interface FeatureCardProps {
    icon: React.ReactNode;
    title: string;
    description: string;
    delay?: number;
    className?: string;
}

const FeatureCard: React.FC<FeatureCardProps> = ({
    icon,
    title,
    description,
    className = ''
}) => {
    return (
        <div
            className={`feature-card ${className}`}
        >
            <div className="feature-icon">
                {icon}
            </div>
            <h3 className="feature-title">{title}</h3>
            <p className="feature-description">{description}</p>
        </div>
    );
};

export default FeatureCard;