import React from 'react';

const AnimatedBackground: React.FC = () => {
    // Consolidated error codes and binary patterns
    const errorElements = [
        { type: 'hex', value: '0x0000000A', top: '15%', left: '10%' },
        { type: 'text', value: 'IRQL_NOT_LESS_OR_EQUAL', top: '60%', right: '15%' },
        { type: 'hex', value: '0x00000050', bottom: '35%', left: '20%' },
        { type: 'text', value: 'PAGE_FAULT', top: '40%', right: '25%' },
        { type: 'hex', value: '0x0000003B', bottom: '20%', right: '10%' },
        { type: 'binary', value: '10110101', top: '25%', right: '40%' },
        { type: 'hex', value: '0x000000D1', top: '70%', left: '35%' },
        { type: 'binary', value: '01001110', bottom: '25%', left: '45%' },
        { type: 'text', value: 'KERNEL_MODE', top: '80%', right: '35%' },
        { type: 'binary', value: '11010010', top: '45%', left: '5%' }
    ];

    return (
        <div className="animated-bg">
            <div className="animated-bg-layer layer-1">
                {/* Consolidated floating elements */}
                <div className="floating-elements">
                    {errorElements.map((element, i) => (
                        <div 
                            key={i} 
                            className={`floating-element ${element.type}`}
                            style={{ 
                                ...(element.top && { top: element.top }),
                                ...(element.bottom && { bottom: element.bottom }),
                                ...(element.left && { left: element.left }),
                                ...(element.right && { right: element.right }),
                                animationDelay: `${i * 2}s`,
                                animationDuration: `${20 + (i % 3) * 5}s`
                            }}
                        >
                            {element.value}
                        </div>
                    ))}
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