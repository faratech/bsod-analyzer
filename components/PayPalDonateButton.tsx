import React, { useEffect, useRef, useCallback } from 'react';
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
    const containerRef = useRef<HTMLDivElement>(null);
    const buttonIdRef = useRef(`paypal-donate-${Math.random().toString(36).slice(2, 9)}`);
    const { trackDonation } = useAnalytics();

    const renderButton = useCallback(async () => {
        if (!containerRef.current) return;

        // Clear previous button
        containerRef.current.innerHTML = `<div id="${buttonIdRef.current}"></div>`;

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

            window.PayPal.Donation.Button(config).render(`#${buttonIdRef.current}`);
        } catch {
            // Fallback: render a direct link if SDK fails to load
            if (containerRef.current) {
                const params = new URLSearchParams({
                    business: 'admin@windowsforum.com',
                    item_name: 'BSOD AI Analyzer Support',
                    currency_code: 'USD',
                    no_recurring: isMonthly ? '0' : '1',
                });
                if (amount) {
                    params.set('amount', amount);
                }
                containerRef.current.innerHTML = `
                    <a href="https://www.paypal.com/donate?${params.toString()}"
                       target="_blank"
                       rel="noopener noreferrer"
                       class="btn btn-primary btn-large">
                        ${buttonText}
                    </a>
                `;
            }
        }
    }, [amount, buttonText, isMonthly, trackDonation]);

    useEffect(() => {
        renderButton();
    }, [renderButton]);

    return <div ref={containerRef}></div>;
};

export default PayPalDonateButton;
