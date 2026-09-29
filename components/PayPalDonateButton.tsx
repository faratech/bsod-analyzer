import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useAnalytics } from '../hooks/useAnalytics';

declare global {
    interface Window {
        PayPal?: {
            Donation: {
                Button: (config: Record<string, unknown>) => {
                    render: (selector: string) => void;
                };
            };
        };
    }
}

const PAYPAL_SDK_URL = 'https://www.paypalobjects.com/donate/sdk/donate-sdk.js';

let sdkLoadPromise: Promise<void> | null = null;

function loadPayPalSdk(): Promise<void> {
    if (window.PayPal?.Donation) {
        return Promise.resolve();
    }
    if (sdkLoadPromise) {
        return sdkLoadPromise;
    }
    sdkLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = PAYPAL_SDK_URL;
        script.charset = 'UTF-8';
        script.onload = () => resolve();
        script.onerror = () => {
            sdkLoadPromise = null;
            reject(new Error('Failed to load PayPal Donate SDK'));
        };
        document.head.appendChild(script);
    });
    return sdkLoadPromise;
}

interface PayPalDonateButtonProps {
    amount?: string;
    buttonText?: string;
    isMonthly?: boolean;
}

const PayPalDonateButton: React.FC<PayPalDonateButtonProps> = ({
    amount,
    buttonText = 'Donate with PayPal',
    isMonthly = false
}) => {
    const mountRef = useRef<HTMLDivElement>(null);
    // Deterministic, hydration-safe id: a render-time Math.random() id is
    // baked into the prerendered /donate markup, and hydration then computes a
    // different one — the PayPal SDK would render into a selector that does
    // not exist and silently no-op, leaving both donate buttons dead on
    // direct visits (issue #117). The two instances differ by isMonthly.
    const buttonId = `paypal-donate-${isMonthly ? 'monthly' : 'one-time'}`;
    const [sdkFailed, setSdkFailed] = useState(false);
    const { trackDonation } = useAnalytics();

    const renderButton = useCallback(async () => {
        if (!mountRef.current) return;

        try {
            await loadPayPalSdk();

            if (!window.PayPal?.Donation) return;

            const config: Record<string, unknown> = {
                env: 'production',
                business: 'admin@windowsforum.com',
                item_name: 'BSOD AI Analyzer Support',
                currency_code: 'USD',
                no_recurring: isMonthly ? '0' : '1',
                image: {
                    src: 'https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif',
                    title: 'PayPal - The safer, easier way to pay online!',
                    alt: 'Donate with PayPal button',
                },
                onComplete: () => {
                    trackDonation(amount || '0', isMonthly ? 'monthly' : 'one-time');
                },
            };

            if (amount) {
                config.amount = amount;
            }

            // Re-renders (amount change) must replace the previous button,
            // not stack a second one inside the same container.
            document.getElementById(buttonId)?.replaceChildren();
            window.PayPal.Donation.Button(config).render(`#${buttonId}`);
        } catch {
            // Fallback: render a direct link if SDK fails to load. JSX rather
            // than innerHTML so no prop can ever become markup (issue #81).
            setSdkFailed(true);
        }
    }, [amount, buttonText, isMonthly, trackDonation, buttonId]);

    useEffect(() => {
        renderButton();
    }, [renderButton]);

    if (sdkFailed) {
        const params = new URLSearchParams({
            business: 'admin@windowsforum.com',
            item_name: 'BSOD AI Analyzer Support',
            currency_code: 'USD',
            no_recurring: isMonthly ? '0' : '1',
        });
        if (amount) {
            params.set('amount', amount);
        }
        return (
            <a
                href={`https://www.paypal.com/donate?${params.toString()}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary btn-large"
            >
                {buttonText}
            </a>
        );
    }

    return (
        <div ref={mountRef}>
            <div id={buttonId} />
        </div>
    );
};

export default PayPalDonateButton;
