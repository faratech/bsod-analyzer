import React from 'react';
import { Link } from 'react-router-dom';

interface LogoProps {
    onClick?: () => void;
    showLink?: boolean;
    className?: string;
}

const Logo: React.FC<LogoProps> = ({ onClick, showLink = true, className = '' }) => {
    const logoContent = (
        <>
            <div className="logo-icon">
                <img 
                    src="/logo-header.webp" 
                    srcSet="/logo-header.webp 1x, /logo-header@2x.webp 2x"
                    alt="BSOD AI Analyzer Logo"
                    width="48"
                    height="48"
                    loading="eager"
                />
            </div>
            <div>
                <div className="logo-text">BSOD AI Analyzer</div>
                <div className="logo-subtitle">By WindowsForum</div>
            </div>
        </>
    );

    if (showLink) {
        return (
            <Link to="/" className={`logo ${className}`} aria-label="BSOD AI Analyzer Home" onClick={onClick}>
                {logoContent}
            </Link>
        );
    }

    return (
        <div className={`logo ${className}`}>
            {logoContent}
        </div>
    );
};

export default Logo;