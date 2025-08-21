import React from 'react';
import { Link } from 'react-router-dom';
import { UploadFeatureIcon, AnalyzeFeatureIcon, ResolveFeatureIcon } from './Icons';

const HeroNav: React.FC = () => {
    return (
        <div className="hero-nav">
            <Link to="/analyzer" className="hero-nav-item">
                <UploadFeatureIcon className="hero-nav-icon" />
                <span>Start Analysis</span>
            </Link>
            <Link to="/documentation" className="hero-nav-item">
                <AnalyzeFeatureIcon className="hero-nav-icon" />
                <span>Learn More</span>
            </Link>
            <Link to="/about" className="hero-nav-item">
                <ResolveFeatureIcon className="hero-nav-icon" />
                <span>How It Works</span>
            </Link>
        </div>
    );
};

export default HeroNav;