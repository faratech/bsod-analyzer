import React, { useEffect, useRef } from 'react';
import { useAnalytics } from '../hooks/useAnalytics';

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
    const buttonRef = useRef<HTMLDivElement>(null);
    const { trackDonation } = useAnalytics();

    useEffect(() => {
        // Create a form dynamically for PayPal donation
        if (buttonRef.current) {
            buttonRef.current.innerHTML = '';
            
            const form = document.createElement('form');
            form.action = 'https://www.paypal.com/donate';
            form.method = 'post';
            form.target = '_blank';
            
            // Hidden inputs for PayPal
            const inputs = [
                { name: 'business', value: 'admin@windowsforum.com' },
                { name: 'no_recurring', value: isMonthly ? '0' : '1' },
                { name: 'item_name', value: 'BSOD AI Analyzer Support' },
                { name: 'currency_code', value: 'USD' },
                { name: 'return', value: window.location.origin + '/donate?success=true' },
                { name: 'cancel_return', value: window.location.origin + '/donate' }
            ];
            
            // Add amount if specified
            if (amount) {
                inputs.push({ name: 'amount', value: amount });
            }
            
            // If monthly, set up recurring
            if (isMonthly) {
                inputs.push({ name: 'cmd', value: '_xclick-subscriptions' });
                inputs.push({ name: 'a3', value: amount || '5' }); // amount
                inputs.push({ name: 'p3', value: '1' }); // period
                inputs.push({ name: 't3', value: 'M' }); // monthly
                inputs.push({ name: 'src', value: '1' }); // recurring
            } else {
                inputs.push({ name: 'cmd', value: '_donations' });
            }
            
            // Create hidden inputs
            inputs.forEach(({ name, value }) => {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = name;
                input.value = value;
                form.appendChild(input);
            });
            
            // Create submit button
            const submitButton = document.createElement('button');
            submitButton.type = 'submit';
            submitButton.className = 'btn btn-primary btn-large';
            submitButton.innerHTML = `
                <svg style="width: 20px; height: 20px; margin-right: 8px;" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944 3.72c.07-.37.39-.693.767-.693h6.184c2.59 0 4.77 1.17 4.77 3.93 0 3.51-3.007 4.14-4.77 4.14h-2.79c-.087 0-.16.057-.171.142l-1.06 5.97c-.06.34-.36.63-.717.63zM19.606 7.344c-.247-1.366-1.558-2.328-3.178-2.328h-3.93c-.395 0-.714.32-.75.714l-2.259 12.857c-.037.216.13.41.35.41h2.36c.276 0 .51-.202.547-.477l.6-3.424a.7.7 0 0 1 .69-.577h1.6c2.432 0 4.34-2.01 4.34-4.577 0-.859-.17-1.644-.37-2.327z"/>
                </svg>
                ${buttonText}
            `;
            
            // Track donation click
            submitButton.addEventListener('click', () => {
                trackDonation(amount || '0', isMonthly ? 'monthly' : 'one-time');
            });
            
            form.appendChild(submitButton);
            
            buttonRef.current.appendChild(form);
        }
    }, [amount, buttonText, isMonthly, trackDonation]);

    return <div ref={buttonRef}></div>;
};

export default PayPalDonateButton;