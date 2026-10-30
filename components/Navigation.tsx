import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import Logo from './Logo';
import ThemeToggle from './ThemeToggle';
import ClientOnly from './ClientOnly';
import AccountWidget from './AccountWidget';
import { SSO_ENABLED } from '../services/featureFlags';

const Navigation: React.FC = () => {
    const location = useLocation();
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const toggleRef = useRef<HTMLButtonElement>(null);
    const mobileNavRef = useRef<HTMLElement>(null);
    
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
    
    // The open menu is modal: the overlay covers the page, so the page behind
    // it (every sibling but the header, which holds the close toggle) is inert,
    // focus moves into the menu, and Escape closes it back onto the toggle.
    useEffect(() => {
        const menu = mobileNavRef.current;
        if (!isMobileMenuOpen || !menu) return;
        const header = toggleRef.current?.closest('header');
        const background = Array.from(menu.parentElement?.children ?? []).filter(
            el => el !== menu && el !== header && !el.hasAttribute('inert')
        );
        background.forEach(el => el.setAttribute('inert', ''));
        menu.querySelector<HTMLElement>('a[href], button')?.focus();

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsMobileMenuOpen(false);
                toggleRef.current?.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            background.forEach(el => el.removeAttribute('inert'));
        };
    }, [isMobileMenuOpen]);

    // Close mobile menu when route changes
    useEffect(() => {
        closeMobileMenu();
    }, [location.pathname]);

    // Close the menu when the viewport grows past the nav collapse threshold.
    // The stylesheet hides the overlay above it, but isMobileMenuOpen would stay
    // true and keep the `mobile-menu-open` scroll lock on <body> — leaving the page
    // unscrollable with no visible menu to dismiss. Threshold matches styles.css.
    useEffect(() => {
        const desktop = window.matchMedia('(min-width: 1025px)');
        const syncToViewport = () => {
            if (desktop.matches) {
                setIsMobileMenuOpen(false);
            }
        };
        syncToViewport();
        desktop.addEventListener('change', syncToViewport);
        return () => desktop.removeEventListener('change', syncToViewport);
    }, []);
    
    return (
        <>
            <header className="header">
                <div className="container">
                    <div className="header-content">
                        <Logo onClick={closeMobileMenu} />
                        
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
                            <Link to="/stats" className={`nav-link ${isActive('/stats') ? 'active' : ''}`}>
                                Stats
                            </Link>
                            <a href="https://windowsforum.com/" target="_blank" rel="noopener noreferrer" className="nav-link">
                                Community
                            </a>
                            <Link to="/donate" className={`nav-link donate-link ${isActive('/donate') ? 'active' : ''}`}>
                                Support Us
                            </Link>
                            <ThemeToggle />
                            {SSO_ENABLED && (
                                <ClientOnly>
                                    <AccountWidget />
                                </ClientOnly>
                            )}
                        </nav>

                        {/* Mobile Menu Button */}
                        <button
                            ref={toggleRef}
                            className="mobile-menu-toggle"
                            onClick={toggleMobileMenu}
                            aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
                            aria-expanded={isMobileMenuOpen}
                            aria-controls="mobile-nav"
                        >
                            <span className={`hamburger-line ${isMobileMenuOpen ? 'open' : ''}`}></span>
                            <span className={`hamburger-line ${isMobileMenuOpen ? 'open' : ''}`}></span>
                            <span className={`hamburger-line ${isMobileMenuOpen ? 'open' : ''}`}></span>
                        </button>
                    </div>
                </div>
            </header>
            
            {/* Mobile Navigation - Outside of header */}
            <nav
                id="mobile-nav"
                ref={mobileNavRef}
                aria-label="Site menu"
                className={`mobile-nav ${isMobileMenuOpen ? 'open' : ''}`}
            >
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
                        to="/stats"
                        className={`mobile-nav-link ${isActive('/stats') ? 'active' : ''}`}
                        onClick={closeMobileMenu}
                    >
                        Stats
                    </Link>
                    <a
                        href="https://windowsforum.com/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mobile-nav-link"
                        onClick={closeMobileMenu}
                    >
                        Community
                    </a>
                    <Link
                        to="/donate"
                        className={`mobile-nav-link donate-link ${isActive('/donate') ? 'active' : ''}`}
                        onClick={closeMobileMenu}
                    >
                        Support Us
                    </Link>
                    {/* The desktop nav (and its toggle) is hidden at <= 1024 px. */}
                    <div className="mobile-nav-theme">
                        <span>Theme</span>
                        <ThemeToggle />
                    </div>
                    {SSO_ENABLED && (
                        <ClientOnly>
                            <AccountWidget mobile />
                        </ClientOnly>
                    )}
                </div>
            </nav>
        </>
    );
};

export default Navigation;