import React from 'react';

const AnimatedBackground: React.FC = () => {
    return (
        <div className="animated-bg">
            <div className="animated-bg-layer layer-1">
                <div className="code-rain">
                    {Array.from({ length: 20 }).map((_, i) => (
                        <div key={i} className="code-drop" style={{ 
                            left: `${Math.random() * 100}%`,
                            animationDelay: `${Math.random() * 5}s`,
                            animationDuration: `${15 + Math.random() * 10}s`
                        }}>
                            {Array.from({ length: 30 }).map((_, j) => (
                                <span key={j} style={{ opacity: Math.random() }}>
                                    {Math.random() > 0.5 ? '0' : '1'}
                                </span>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
            
            <div className="animated-bg-layer layer-2">
                {/* Floating error codes */}
                <div className="floating-errors">
                    <div className="error-code" style={{ top: '20%', left: '10%' }}>0x0000000A</div>
                    <div className="error-code" style={{ top: '60%', right: '15%' }}>IRQL_NOT_LESS_OR_EQUAL</div>
                    <div className="error-code" style={{ bottom: '30%', left: '20%' }}>0x00000050</div>
                    <div className="error-code" style={{ top: '40%', right: '30%' }}>PAGE_FAULT</div>
                    <div className="error-code" style={{ bottom: '20%', right: '10%' }}>0x0000003B</div>
                </div>
            </div>
            
            <div className="animated-bg-layer layer-3">
                {/* Circuit pattern */}
                <svg className="circuit-svg" viewBox="0 0 1920 1080">
                    <defs>
                        <pattern id="circuit-pattern" x="0" y="0" width="100" height="100" patternUnits="userSpaceOnUse">
                            <circle cx="5" cy="5" r="2" fill="var(--brand-primary)" opacity="0.3" />
                            <line x1="5" y1="5" x2="95" y2="5" stroke="var(--brand-primary)" strokeWidth="0.5" opacity="0.2" />
                            <line x1="5" y1="5" x2="5" y2="95" stroke="var(--brand-primary)" strokeWidth="0.5" opacity="0.2" />
                        </pattern>
                    </defs>
                    <rect width="100%" height="100%" fill="url(#circuit-pattern)" />
                </svg>
            </div>
            
            {/* Glitch effect overlay */}
            <div className="glitch-overlay"></div>
        </div>
    );
};

export default AnimatedBackground;