import React from 'react';

interface ErrorAlertProps {
    error: string;
    className?: string;
}

const ErrorAlert: React.FC<ErrorAlertProps> = ({ error, className = '' }) => {
    return (
        <div 
            className={`card status-error fade-in ${className}`} 
            style={{ padding: '1.5rem', color: 'var(--text-primary)'}} 
            role="alert"
        >
            <strong>Error: </strong>
            <span>{error}</span>
        </div>
    );
};

export default ErrorAlert;