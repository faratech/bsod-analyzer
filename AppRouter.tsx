import React, { useEffect, Suspense } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import Navigation from './components/Navigation';
import Footer from './components/Footer';
import Loader from './components/Loader';
import ChunkErrorBoundary from './components/ChunkErrorBoundary';
import StructuredData from './components/StructuredData';
import ClientOnly from './components/ClientOnly';
import { useBreadcrumbs } from './hooks/useBreadcrumbs';
import { useAnalytics } from './hooks/useAnalytics';
import { ThemeProvider } from './hooks/useTheme';
// Home is imported eagerly (not lazy) so the same tree renders during the
// static prerender and on the client — required for clean hydration of "/".
import Home from './pages/Home';

// Remaining routes stay lazy (client-only, rendered on navigation).
const Analyzer = React.lazy(() => import('./pages/Analyzer'));
const About = React.lazy(() => import('./pages/About'));
const Documentation = React.lazy(() => import('./pages/Documentation'));
const Donate = React.lazy(() => import('./pages/Donate'));
const NotFound = React.lazy(() => import('./pages/NotFound'));

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
            {breadcrumbData && (
                <ClientOnly>
                    <StructuredData data={breadcrumbData} />
                </ClientOnly>
            )}
            <Navigation />
            <ChunkErrorBoundary>
                <Suspense fallback={<Loader />}>
                    <Routes>
                        <Route path="/" element={<Home />} />
                        <Route path="/analyzer" element={<Analyzer />} />
                        <Route path="/about" element={<About />} />
                        <Route path="/documentation" element={<Documentation />} />
                        <Route path="/donate" element={<Donate />} />
                        <Route path="*" element={<NotFound />} />
                    </Routes>
                </Suspense>
            </ChunkErrorBoundary>
            <Footer />
        </div>
    );
};

/**
 * The app without a router. The router is supplied by the entry point —
 * BrowserRouter on the client (index.tsx), StaticRouter during the build-time
 * prerender (entry-server.tsx) — so the identical tree renders in both places.
 */
export const AppShell: React.FC = () => (
    <ThemeProvider>
        <AppContent />
    </ThemeProvider>
);

export default AppShell;
