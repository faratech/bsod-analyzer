import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AnimatedLogoIcon } from './Icons';

const Navigation: React.FC = () => {
    const location = useLocation();
    
    const isActive = (path: string) => location.pathname === path;
    
    return (
        <header className="header">
            <div className="container">
                <div className="header-content">
                    <Link to="/" className="logo" aria-label="BSOD AI Analyzer Home">
                        <div className="logo-icon">
                            <AnimatedLogoIcon />
                        </div>
                        <div>
                            <div className="logo-text">BSOD AI Analyzer</div>
                            <div className="logo-subtitle">By WindowsForum</div>
                        </div>
                    </Link>
                    
                    <nav className="nav">
                        <Link to="/" className={`nav-link ${isActive('/') ? 'active' : ''}`}>
                            Home
                        </Link>
                        <Link to="/analyzer" className={`nav-link ${isActive('/analyzer') ? 'active' : ''}`}>
                            Analyzer
                        </Link>
                        <Link to="/about" className={`nav-link ${isActive('/about') ? 'active' : ''}`}>
                            About
                        </Link>
                        <Link to="/documentation" className={`nav-link ${isActive('/documentation') ? 'active' : ''}`}>
                            Documentation
                        </Link>
                        <Link to="/donate" className={`nav-link donate-link ${isActive('/donate') ? 'active' : ''}`}>
                            Support Us
                        </Link>
                    </nav>
                </div>
            </div>
        </header>
    );
};

export default Navigation;