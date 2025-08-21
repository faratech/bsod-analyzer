import React, { useEffect, useRef, useCallback } from 'react';

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    size: number;
    opacity: number;
    char: string;
    color: string;
    type: 'binary' | 'hex' | 'error';
    targetChar?: string;
    charChangeProgress?: number;
    rotationSpeed?: number;
    rotation?: number;
}

interface GlitchLine {
    y: number;
    height: number;
    opacity: number;
    speed: number;
}

// Constants moved outside component to prevent recreation
const COLUMN_WIDTH = 20;
const PARTICLE_COUNT = 30; // Reduced from 50
const GLITCH_COUNT = 2; // Reduced from 3
const CHARS = {
    binary: ['0', '1'],
    hex: '0123456789ABCDEF'.split(''),
    all: '01234567890ABCDEF'.split('')
};

const HeroAnimation: React.FC = React.memo(() => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const mouseRef = useRef({ x: 0, y: 0 });
    const particlesRef = useRef<Particle[]>([]);
    const glitchLinesRef = useRef<GlitchLine[]>([]);
    const matrixColumnsRef = useRef<{ 
        x: number; 
        y: number; 
        speed: number; 
        chars: string[]; 
        charRotations?: number[];
        sorting?: boolean;
        sortProgress?: number;
    }[]>([]);
    const frameCountRef = useRef(0);
    const animationIdRef = useRef<number>();

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d', { 
            alpha: false,
            desynchronized: true 
        });
        if (!ctx) return;

        // Optimized canvas resize
        const resizeCanvas = useCallback(() => {
            const dpr = Math.min(window.devicePixelRatio || 1, 2); // Cap at 2x for performance
            canvas.width = window.innerWidth * dpr;
            canvas.height = window.innerHeight * dpr;
            canvas.style.width = window.innerWidth + 'px';
            canvas.style.height = window.innerHeight + 'px';
            ctx.scale(dpr, dpr);
            initializeEffects();
        }, []);

        // Optimized initialization
        const initializeEffects = useCallback(() => {
            // Clear existing
            particlesRef.current = [];
            glitchLinesRef.current = [];
            matrixColumnsRef.current = [];

            // Initialize fewer matrix columns for performance
            const columns = Math.floor(canvas.width / COLUMN_WIDTH / 2); // Half the columns
            for (let i = 0; i < columns; i++) {
                matrixColumnsRef.current.push({
                    x: i * COLUMN_WIDTH * 2 + COLUMN_WIDTH,
                    y: Math.random() * -canvas.height,
                    speed: 2 + Math.random() * 3,
                    chars: Array(15).fill(0).map(() => // Fewer chars
                        CHARS.all[Math.floor(Math.random() * CHARS.all.length)]
                    )
                });
            }

            // Initialize fewer particles
            for (let i = 0; i < PARTICLE_COUNT; i++) {
                const char = CHARS.all[Math.floor(Math.random() * CHARS.all.length)];
                particlesRef.current.push({
                    x: Math.random() * canvas.width,
                    y: Math.random() * canvas.height,
                    vx: (Math.random() - 0.5) * 0.3, // Slower movement
                    vy: (Math.random() - 0.5) * 0.3,
                    size: Math.random() * 2 + 1,
                    opacity: Math.random() * 0.4 + 0.1,
                    char: char,
                    color: Math.random() > 0.8 ? '#ef4444' : '#3b82f6',
                    type: Math.random() > 0.9 ? 'error' : Math.random() > 0.5 ? 'binary' : 'hex',
                    targetChar: char,
                    charChangeProgress: 0,
                    rotationSpeed: (Math.random() - 0.5) * 0.01,
                    rotation: 0
                });
            }

            // Initialize fewer glitch lines
            for (let i = 0; i < GLITCH_COUNT; i++) {
                glitchLinesRef.current.push({
                    y: Math.random() * canvas.height,
                    height: Math.random() * 2 + 1,
                    opacity: 0,
                    speed: Math.random() * 3 + 1
                });
            }
        }, [canvas.width, canvas.height]);

        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        // Throttled mouse tracking
        let mouseThrottle: NodeJS.Timeout;
        const handleMouseMove = (e: MouseEvent) => {
            if (!mouseThrottle) {
                mouseThrottle = setTimeout(() => {
                    mouseRef.current = { x: e.clientX, y: e.clientY };
                    mouseThrottle = null;
                }, 50); // 20fps for mouse tracking
            }
        };
        window.addEventListener('mousemove', handleMouseMove);

        // Optimized animation loop
        const draw = () => {
            frameCountRef.current++;

            // Clear with fade effect (less frequent for performance)
            ctx.fillStyle = 'rgba(10, 10, 10, 0.1)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Draw matrix rain (skip frames for performance)
            if (frameCountRef.current % 2 === 0) {
                ctx.font = '14px monospace';
                matrixColumnsRef.current.forEach((column, index) => {
                    // Reduce sorting frequency
                    if (!column.sorting && Math.random() > 0.999) {
                        column.sorting = true;
                        column.sortProgress = 0;
                    }

                    // Update sorting progress
                    if (column.sorting) {
                        column.sortProgress = (column.sortProgress || 0) + 0.05;
                        if (column.sortProgress >= 1) {
                            column.sorting = false;
                        }
                    }

                    column.chars.forEach((char, charIndex) => {
                        const y = column.y + charIndex * 20;
                        
                        if (y > 0 && y < canvas.height) {
                            // Simple opacity calculation
                            const opacity = Math.max(0, 1 - (y / canvas.height));
                            
                            // Less frequent character changes
                            if (Math.random() > 0.998) {
                                column.chars[charIndex] = CHARS.all[Math.floor(Math.random() * CHARS.all.length)];
                            }
                            
                            // Simplified color
                            ctx.fillStyle = `rgba(59, 130, 246, ${opacity * 0.6})`;
                            
                            // Skip rotation for performance
                            ctx.fillText(char, column.x, y);
                            
                            // Glow only for last char, no shadows for performance
                            if (charIndex === column.chars.length - 1) {
                                ctx.fillStyle = `rgba(96, 165, 250, ${opacity})`;
                                ctx.fillText(char, column.x, y);
                            }
                        }
                    });

                // Update position
                column.y += column.speed;
                
                    // Reset when off screen
                    if (column.y > canvas.height + column.chars.length * 20) {
                        column.y = -column.chars.length * 20;
                        column.speed = 2 + Math.random() * 3;
                    }
                });
            }

            // Draw particles (every 3rd frame for performance)
            if (frameCountRef.current % 3 === 0) {
                ctx.font = '16px monospace';
                particlesRef.current.forEach(particle => {
                    // Update position
                    particle.x += particle.vx;
                    particle.y += particle.vy;
                    
                    // Simple wrap around
                    if (particle.x < 0) particle.x = canvas.width;
                    if (particle.x > canvas.width) particle.x = 0;
                    if (particle.y < 0) particle.y = canvas.height;
                    if (particle.y > canvas.height) particle.y = 0;

                    // Simple character change
                    if (Math.random() > 0.998) {
                        particle.char = CHARS.all[Math.floor(Math.random() * CHARS.all.length)];
                    }

                    // Draw particle without transforms for performance
                    ctx.fillStyle = particle.color;
                    ctx.globalAlpha = particle.opacity;
                    ctx.fillText(particle.char, particle.x, particle.y);
                });
                ctx.globalAlpha = 1;

            }

            // Simple glitch effect (every 10th frame)
            if (frameCountRef.current % 10 === 0 && Math.random() > 0.95) {
                const glitchY = Math.random() * canvas.height;
                ctx.fillStyle = 'rgba(59, 130, 246, 0.3)';
                ctx.fillRect(0, glitchY, canvas.width, 2);
            }

            // Simple scan line (every frame)
            const scanLineY = (frameCountRef.current * 2) % canvas.height;
            ctx.fillStyle = 'rgba(59, 130, 246, 0.05)';
            ctx.fillRect(0, scanLineY - 1, canvas.width, 2);

            animationIdRef.current = requestAnimationFrame(draw);
        };

        draw();

        return () => {
            if (animationIdRef.current) {
                cancelAnimationFrame(animationIdRef.current);
            }
            window.removeEventListener('resize', resizeCanvas);
            window.removeEventListener('mousemove', handleMouseMove);
            if (mouseThrottle) {
                clearTimeout(mouseThrottle);
            }
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            className="hero-animation-canvas"
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
            }}
        />
    );
});

HeroAnimation.displayName = 'HeroAnimation';

export default HeroAnimation;