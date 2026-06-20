import { useCallback } from 'react';

// Google Analytics event tracking hook
declare global {
    interface Window {
        gtag: (...args: any[]) => void;
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

    const trackPageView = useCallback((pagePath: string) => {
        if (typeof window !== 'undefined' && window.gtag) {
            window.gtag('config', 'G-0HVHB49RDP', {
                page_path: pagePath
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
