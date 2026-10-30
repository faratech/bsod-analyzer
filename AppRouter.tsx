import React, { useEffect, useRef, Suspense } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import Navigation from './components/Navigation';
import Footer from './components/Footer';
import Loader from './components/Loader';
import ChunkErrorBoundary from './components/ChunkErrorBoundary';
import { lazyRoute } from './utils/chunkReload';
import StructuredData from './components/StructuredData';
import ClientOnly from './components/ClientOnly';
import { useBreadcrumbs } from './hooks/useBreadcrumbs';
import { useAnalytics } from './hooks/useAnalytics';
import { ThemeProvider } from './hooks/useTheme';
import { AuthProvider } from './hooks/useAuth';
// Home is imported eagerly (not lazy) so the same tree renders during the
// static prerender and on the client — required for clean hydration of "/".
import Home from './pages/Home';

// Remaining routes stay lazy (client-only, rendered on navigation). lazyRoute
// marks a failed import as a chunk error so ChunkErrorBoundary reloads.
const Analyzer = lazyRoute(() => import('./pages/Analyzer'));
const About = lazyRoute(() => import('./pages/About'));
const Documentation = lazyRoute(() => import('./pages/Documentation'));
const Donate = lazyRoute(() => import('./pages/Donate'));
const StatsPage = lazyRoute(() => import('./pages/Stats'));
const Privacy = lazyRoute(() => import('./pages/Privacy'));
// Same chunk, named export — the chromeless widget for forum iframes.
const StatsEmbedPage = lazyRoute(() =>
  import('./pages/Stats').then(module => ({ default: module.StatsEmbedPage }))
);
const NotFound = lazyRoute(() => import('./pages/NotFound'));

const AppContent: React.FC = () => {
    const breadcrumbData = useBreadcrumbs();
    const location = useLocation();
    const { trackPageView } = useAnalytics();
    // The embed widget renders chrome-free inside third-party iframes.
    const isEmbed = location.pathname === '/stats/embed';

    useEffect(() => {
        // Track page views on route change
        trackPageView(location.pathname);
    }, [location.pathname, trackPageView]);

    const previousPathname = useRef<string | null>(null);
    useEffect(() => {
        // Scroll on navigation: to the #hash target when the link names one
        // that exists, otherwise to the top, but only when the pathname
        // changed (or on mount). A hash-only change (in-page link, Back from
        // /about#x to /about, a missing anchor) never jumps to the top
        // (issue #280). React runs a page's effects before this parent effect,
        // so a page that is already loaded (cached lazy chunk) has its target
        // in the DOM here and must not be sent back to the top. A page still
        // loading starts at the top; About and Documentation scroll to the
        // hash themselves once their chunk commits.
        const pathnameChanged = previousPathname.current !== location.pathname;
        previousPathname.current = location.pathname;
        let target: HTMLElement | null = null;
        if (location.hash.length > 1) {
            try {
                target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
            } catch {
                target = null;
            }
        }
        if (target) {
            target.scrollIntoView({ behavior: 'smooth' });
        } else if (pathnameChanged) {
            window.scrollTo(0, 0);
        }
    }, [location.pathname, location.hash]);

    return (
        <div className={isEmbed ? 'app app-embed' : 'app'}>
            {breadcrumbData && (
                <ClientOnly>
                    <StructuredData data={breadcrumbData} />
                </ClientOnly>
            )}
            {!isEmbed && <Navigation />}
            <ChunkErrorBoundary resetKey={location.pathname}>
                <Suspense fallback={<Loader fullPage />}>
                    <Routes>
                        <Route path="/" element={<Home />} />
                        <Route path="/analyzer" element={<Analyzer />} />
                        <Route path="/about" element={<About />} />
                        <Route path="/privacy" element={<Privacy />} />
                        <Route path="/documentation" element={<Documentation />} />
                        <Route path="/donate" element={<Donate />} />
                        <Route path="/stats" element={<StatsPage />} />
                        <Route path="/stats/embed" element={<StatsEmbedPage />} />
                        <Route path="*" element={<NotFound />} />
                    </Routes>
                </Suspense>
            </ChunkErrorBoundary>
            {!isEmbed && <Footer />}
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
        <AuthProvider>
            <AppContent />
        </AuthProvider>
    </ThemeProvider>
);

export default AppShell;
