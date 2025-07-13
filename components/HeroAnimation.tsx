import React, { useEffect, useRef } from 'react';

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
}

interface GlitchLine {
    y: number;
    height: number;
    opacity: number;
    speed: number;
}

const HeroAnimation: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const mouseRef = useRef({ x: 0, y: 0 });
    const particlesRef = useRef<Particle[]>([]);
    const glitchLinesRef = useRef<GlitchLine[]>([]);
    const matrixColumnsRef = useRef<{ x: number; y: number; speed: number; chars: string[] }[]>([]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Set canvas size
        const resizeCanvas = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            initializeEffects();
        };

        // Initialize effects
        const initializeEffects = () => {
            // Clear existing
            particlesRef.current = [];
            glitchLinesRef.current = [];
            matrixColumnsRef.current = [];

            // Initialize matrix rain columns
            const columnWidth = 20;
            const columns = Math.floor(canvas.width / columnWidth);
            for (let i = 0; i < columns; i++) {
                matrixColumnsRef.current.push({
                    x: i * columnWidth + columnWidth / 2,
                    y: Math.random() * -canvas.height,
                    speed: 2 + Math.random() * 4,
                    chars: Array(20).fill(0).map(() => 
                        Math.random() > 0.5 ? '01'[Math.floor(Math.random() * 2)] : 
                        '0123456789ABCDEF'[Math.floor(Math.random() * 16)]
                    )
                });
            }

            // Initialize floating particles
            for (let i = 0; i < 50; i++) {
                particlesRef.current.push({
                    x: Math.random() * canvas.width,
                    y: Math.random() * canvas.height,
                    vx: (Math.random() - 0.5) * 0.5,
                    vy: (Math.random() - 0.5) * 0.5,
                    size: Math.random() * 3 + 1,
                    opacity: Math.random() * 0.5 + 0.2,
                    char: ['0', '1', 'A', 'F', '7', 'E'][Math.floor(Math.random() * 6)],
                    color: Math.random() > 0.8 ? '#ef4444' : '#3b82f6',
                    type: Math.random() > 0.9 ? 'error' : Math.random() > 0.5 ? 'binary' : 'hex'
                });
            }

            // Initialize glitch lines
            for (let i = 0; i < 3; i++) {
                glitchLinesRef.current.push({
                    y: Math.random() * canvas.height,
                    height: Math.random() * 2 + 1,
                    opacity: 0,
                    speed: Math.random() * 5 + 2
                });
            }
        };

        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        // Mouse tracking
        const handleMouseMove = (e: MouseEvent) => {
            mouseRef.current = { x: e.clientX, y: e.clientY };
        };
        window.addEventListener('mousemove', handleMouseMove);

        // Animation
        let animationId: number;
        let frame = 0;

        const draw = () => {
            frame++;

            // Clear with fade effect
            ctx.fillStyle = 'rgba(10, 10, 10, 0.08)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Draw matrix rain
            ctx.font = '14px JetBrains Mono, monospace';
            matrixColumnsRef.current.forEach((column, index) => {
                column.chars.forEach((char, charIndex) => {
                    const y = column.y + charIndex * 20;
                    if (y > 0 && y < canvas.height) {
                        // Calculate opacity based on position
                        const fadeStart = canvas.height * 0.7;
                        const opacity = y > fadeStart ? 
                            1 - (y - fadeStart) / (canvas.height - fadeStart) : 1;
                        
                        // Color based on position and type
                        const isError = char === 'E' || char === 'F';
                        const hue = isError ? 0 : 210;
                        const lightness = 50 + (charIndex / column.chars.length) * 30;
                        
                        ctx.fillStyle = `hsla(${hue}, 80%, ${lightness}%, ${opacity * 0.8})`;
                        ctx.fillText(char, column.x, y);
                        
                        // Glow effect for bottom chars
                        if (charIndex === column.chars.length - 1) {
                            ctx.shadowBlur = 20;
                            ctx.shadowColor = isError ? '#ef4444' : '#3b82f6';
                            ctx.fillStyle = isError ? '#ff6b6b' : '#60a5fa';
                            ctx.fillText(char, column.x, y);
                            ctx.shadowBlur = 0;
                        }
                    }
                });

                // Update position
                column.y += column.speed;
                
                // Reset when off screen
                if (column.y > canvas.height + column.chars.length * 20) {
                    column.y = -column.chars.length * 20;
                    column.speed = 2 + Math.random() * 4;
                    // Regenerate characters
                    column.chars = Array(20).fill(0).map(() => 
                        Math.random() > 0.5 ? '01'[Math.floor(Math.random() * 2)] : 
                        '0123456789ABCDEF'[Math.floor(Math.random() * 16)]
                    );
                }
            });

            // Draw floating particles with mouse interaction
            particlesRef.current.forEach(particle => {
                // Mouse repulsion
                const dx = particle.x - mouseRef.current.x;
                const dy = particle.y - mouseRef.current.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < 100) {
                    const force = (100 - distance) / 100;
                    particle.vx += (dx / distance) * force * 0.5;
                    particle.vy += (dy / distance) * force * 0.5;
                }

                // Update position
                particle.x += particle.vx;
                particle.y += particle.vy;
                
                // Damping
                particle.vx *= 0.98;
                particle.vy *= 0.98;

                // Wrap around screen
                if (particle.x < 0) particle.x = canvas.width;
                if (particle.x > canvas.width) particle.x = 0;
                if (particle.y < 0) particle.y = canvas.height;
                if (particle.y > canvas.height) particle.y = 0;

                // Draw particle
                ctx.save();
                ctx.font = `${12 + particle.size * 2}px JetBrains Mono, monospace`;
                ctx.fillStyle = particle.color;
                ctx.globalAlpha = particle.opacity;
                
                // Add glow for error particles
                if (particle.type === 'error') {
                    ctx.shadowBlur = 10;
                    ctx.shadowColor = particle.color;
                }
                
                ctx.fillText(particle.char, particle.x, particle.y);
                ctx.restore();
            });

            // Draw glitch effects
            glitchLinesRef.current.forEach(glitch => {
                // Randomly activate glitch
                if (Math.random() > 0.995) {
                    glitch.opacity = 0.8;
                    glitch.y = Math.random() * canvas.height;
                }

                if (glitch.opacity > 0) {
                    ctx.fillStyle = `rgba(59, 130, 246, ${glitch.opacity})`;
                    ctx.fillRect(0, glitch.y, canvas.width, glitch.height);
                    
                    // Distortion effect
                    const imageData = ctx.getImageData(0, glitch.y - 10, canvas.width, 20);
                    ctx.putImageData(imageData, Math.sin(frame * 0.1) * 10, glitch.y - 10);
                    
                    glitch.opacity *= 0.95;
                    glitch.y += glitch.speed;
                }
            });

            // Draw scan line
            const scanLineY = (frame * 2) % (canvas.height + 100) - 50;
            const gradient = ctx.createLinearGradient(0, scanLineY - 50, 0, scanLineY + 50);
            gradient.addColorStop(0, 'rgba(59, 130, 246, 0)');
            gradient.addColorStop(0.5, 'rgba(59, 130, 246, 0.1)');
            gradient.addColorStop(1, 'rgba(59, 130, 246, 0)');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, scanLineY - 50, canvas.width, 100);

            // Draw connection lines between nearby particles
            ctx.strokeStyle = 'rgba(59, 130, 246, 0.2)';
            ctx.lineWidth = 1;
            particlesRef.current.forEach((p1, i) => {
                particlesRef.current.slice(i + 1).forEach(p2 => {
                    const dx = p1.x - p2.x;
                    const dy = p1.y - p2.y;
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    if (distance < 100) {
                        ctx.globalAlpha = (1 - distance / 100) * 0.5;
                        ctx.beginPath();
                        ctx.moveTo(p1.x, p1.y);
                        ctx.lineTo(p2.x, p2.y);
                        ctx.stroke();
                    }
                });
            });
            ctx.globalAlpha = 1;

            animationId = requestAnimationFrame(draw);
        };

        draw();

        return () => {
            cancelAnimationFrame(animationId);
            window.removeEventListener('resize', resizeCanvas);
            window.removeEventListener('mousemove', handleMouseMove);
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
};

export default HeroAnimation;