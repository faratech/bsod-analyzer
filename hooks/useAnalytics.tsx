// Google Analytics event tracking hook
declare global {
    interface Window {
        gtag: (...args: any[]) => void;
    }
}

export const useAnalytics = () => {
    const trackEvent = (action: string, category: string, label?: string, value?: number) => {
        if (typeof window !== 'undefined' && window.gtag) {
            window.gtag('event', action, {
                event_category: category,
                event_label: label,
                value: value
            });
        }
    };

    const trackFileUpload = (fileType: string, fileSize: number) => {
        trackEvent('file_upload', 'engagement', fileType, Math.round(fileSize / 1024)); // Size in KB
    };

    const trackAnalysisStart = (dumpType: 'minidump' | 'kernel') => {
        trackEvent('analysis_start', 'engagement', dumpType);
    };

    const trackAnalysisComplete = (success: boolean, dumpType: string) => {
        trackEvent('analysis_complete', 'engagement', `${dumpType}_${success ? 'success' : 'error'}`);
    };

    const trackAdvancedTool = (toolName: string) => {
        trackEvent('advanced_tool_use', 'engagement', toolName);
    };

    const trackDonation = (amount: string, type: 'one-time' | 'monthly') => {
        trackEvent('donation_click', 'conversion', `${type}_${amount}`);
    };

    const trackPageView = (pagePath: string) => {
        if (typeof window !== 'undefined' && window.gtag) {
            window.gtag('config', 'G-0HVHB49RDP', {
                page_path: pagePath
            });
        }
    };

    return {
        trackEvent,
        trackFileUpload,
        trackAnalysisStart,
        trackAnalysisComplete,
        trackAdvancedTool,
        trackDonation,
        trackPageView
    };
};