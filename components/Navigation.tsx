import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AnimatedLogoIcon } from './Icons';

const Navigation: React.FC = () => {
    const location = useLocation();
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    
    const isActive = (path: string) => location.pathname === path;
    
    const toggleMobileMenu = () => {
        setIsMobileMenuOpen(!isMobileMenuOpen);
    };
    
    const closeMobileMenu = () => {
        setIsMobileMenuOpen(false);
    };
    
    // Handle body scroll lock when mobile menu is open
    useEffect(() => {
        if (isMobileMenuOpen) {
            document.body.classList.add('mobile-menu-open');
        } else {
            document.body.classList.remove('mobile-menu-open');
        }
        
        // Cleanup on unmount
        return () => {
            document.body.classList.remove('mobile-menu-open');
        };
    }, [isMobileMenuOpen]);
    
    // Close mobile menu when route changes
    useEffect(() => {
        closeMobileMenu();
    }, [location.pathname]);
    
    return (
        <header className="header">
            <div className="container">
                <div className="header-content">
                    <Link to="/" className="logo" aria-label="BSOD AI Analyzer Home" onClick={closeMobileMenu}>
                        <div className="logo-icon">
                            <AnimatedLogoIcon />
                        </div>
                        <div>
                            <div className="logo-text">BSOD AI Analyzer</div>
                            <div className="logo-subtitle">By WindowsForum</div>
                        </div>
                    </Link>
                    
                    {/* Desktop Navigation */}
                    <nav className="nav desktop-nav">
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
                    
                    {/* Mobile Menu Button */}
                    <button 
                        className="mobile-menu-toggle"
                        onClick={toggleMobileMenu}
                        aria-label="Toggle mobile menu"
                        aria-expanded={isMobileMenuOpen}
                    >
                        <span className={`hamburger-line ${isMobileMenuOpen ? 'open' : ''}`}></span>
                        <span className={`hamburger-line ${isMobileMenuOpen ? 'open' : ''}`}></span>
                        <span className={`hamburger-line ${isMobileMenuOpen ? 'open' : ''}`}></span>
                    </button>
                </div>
                
                {/* Mobile Navigation */}
                <nav className={`mobile-nav ${isMobileMenuOpen ? 'open' : ''}`}>
                    <div className="mobile-nav-content">
                        <Link 
                            to="/" 
                            className={`mobile-nav-link ${isActive('/') ? 'active' : ''}`}
                            onClick={closeMobileMenu}
                        >
                            Home
                        </Link>
                        <Link 
                            to="/analyzer" 
                            className={`mobile-nav-link ${isActive('/analyzer') ? 'active' : ''}`}
                            onClick={closeMobileMenu}
                        >
                            Analyzer
                        </Link>
                        <Link 
                            to="/about" 
                            className={`mobile-nav-link ${isActive('/about') ? 'active' : ''}`}
                            onClick={closeMobileMenu}
                        >
                            About
                        </Link>
                        <Link 
                            to="/documentation" 
                            className={`mobile-nav-link ${isActive('/documentation') ? 'active' : ''}`}
                            onClick={closeMobileMenu}
                        >
                            Documentation
                        </Link>
                        <Link 
                            to="/donate" 
                            className={`mobile-nav-link donate-link ${isActive('/donate') ? 'active' : ''}`}
                            onClick={closeMobileMenu}
                        >
                            Support Us
                        </Link>
                    </div>
                </nav>
            </div>
        </header>
    );
};

export default Navigation;