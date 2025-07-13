import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom';
import Navigation from './components/Navigation';
import Footer from './components/Footer';
import Home from './pages/Home';
import Analyzer from './pages/Analyzer';
import About from './pages/About';
import Documentation from './pages/Documentation';
import Donate from './pages/Donate';
import StructuredData from './components/StructuredData';
import { useBreadcrumbs } from './hooks/useBreadcrumbs';
import { useAnalytics } from './hooks/useAnalytics';

// Extend Window interface for AdSense functions
declare global {
    interface Window {
        refreshAds?: () => void;
        adsenseInitialized?: boolean;
        adsbygoogle?: any[];
    }
}

const AppContent: React.FC = () => {
    const breadcrumbData = useBreadcrumbs();
    const location = useLocation();
    const { trackPageView } = useAnalytics();
    
    useEffect(() => {
        // Track page views on route change
        trackPageView(location.pathname);
        
        // Scroll to top on route change
        window.scrollTo(0, 0);
        
        // Refresh ads for SPA navigation (if ads are present)
        if (typeof window.refreshAds === 'function') {
            // Delay to ensure DOM is updated
            setTimeout(() => {
                window.refreshAds();
            }, 100);
        }
    }, [location.pathname, trackPageView]);
    
    return (
        <div className="app">
            {breadcrumbData && <StructuredData data={breadcrumbData} />}
            <Navigation />
            <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/analyzer" element={<Analyzer />} />
                <Route path="/about" element={<About />} />
                <Route path="/documentation" element={<Documentation />} />
                <Route path="/donate" element={<Donate />} />
            </Routes>
            <Footer />
        </div>
    );
};

const AppRouter: React.FC = () => {
    return (
        <Router>
            <AppContent />
        </Router>
    );
};

export default AppRouter;