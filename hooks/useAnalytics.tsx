import { useCallback } from 'react';

// Google Analytics event tracking hook
declare global {
    interface Window {
        gtag: (...args: any[]) => void;
        __GA_ID__?: string;
    }
}

export const useAnalytics = () => {
    const trackEvent = useCallback((action: string, category: string, label?: string, value?: number) => {
        if (typeof window !== 'undefined' && window.gtag) {
            window.gtag('event', action, {
                event_category: category,
                event_label: label,
                value: value
            });
        }
    }, []);

    const trackFileUpload = useCallback((fileType: string, fileSize: number) => {
        trackEvent('file_upload', 'engagement', fileType, Math.round(fileSize / 1024)); // Size in KB
    }, [trackEvent]);

    const trackAnalysisStart = useCallback((dumpType: string) => {
        trackEvent('analysis_start', 'engagement', dumpType);
    }, [trackEvent]);

    const trackAnalysisComplete = useCallback((success: boolean, dumpType: string) => {
        trackEvent('analysis_complete', 'engagement', `${dumpType}_${success ? 'success' : 'error'}`);
    }, [trackEvent]);

    const trackDonation = useCallback((amount: string, type: 'one-time' | 'monthly') => {
        trackEvent('donation_click', 'conversion', `${type}_${amount}`);
    }, [trackEvent]);

    // One explicit page_view per page. index.html configures gtag with
    // send_page_view: false, so this is the only page view (issue #347);
    // a gtag('config') call here would send a second one.
    //
    // page_location is the URL without its fragment (issue #361): the SSO
    // redirect fallback lands on #wf_sso=<token>, and this first page view
    // runs before AuthProvider strips it. 'set' makes later events (and
    // gtag.js's own page URL) use the same value.
    const trackPageView = useCallback((pagePath: string) => {
        if (typeof window !== 'undefined' && window.gtag) {
            const { origin, pathname, search } = window.location;
            const pageLocation = `${origin}${pathname}${search}`;
            window.gtag('set', { page_location: pageLocation });
            window.gtag('event', 'page_view', {
                page_path: pagePath,
                page_location: pageLocation,
                ...(window.__GA_ID__ ? { send_to: window.__GA_ID__ } : {})
            });
        }
    }, []);

    return {
        trackEvent,
        trackFileUpload,
        trackAnalysisStart,
        trackAnalysisComplete,
        trackDonation,
        trackPageView
    };
};
