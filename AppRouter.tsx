import React, { useEffect, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom';
import Navigation from './components/Navigation';
import Footer from './components/Footer';
import Loader from './components/Loader';
import StructuredData from './components/StructuredData';
import { useBreadcrumbs } from './hooks/useBreadcrumbs';
import { useAnalytics } from './hooks/useAnalytics';

// Lazy load all route components
const Home = React.lazy(() => import('./pages/Home'));
const Analyzer = React.lazy(() => import('./pages/Analyzer'));
const About = React.lazy(() => import('./pages/About'));
const Documentation = React.lazy(() => import('./pages/Documentation'));
const Donate = React.lazy(() => import('./pages/Donate'));

// Extend Window interface for AdSense
declare global {
    interface Window {
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
    }, [location.pathname, trackPageView]);
    
    return (
        <div className="app">
            {breadcrumbData && <StructuredData data={breadcrumbData} />}
            <Navigation />
            <Suspense fallback={<Loader />}>
                <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/analyzer" element={<Analyzer />} />
                    <Route path="/about" element={<About />} />
                    <Route path="/documentation" element={<Documentation />} />
                    <Route path="/donate" element={<Donate />} />
                </Routes>
            </Suspense>
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