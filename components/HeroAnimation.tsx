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

const HeroAnimation: React.FC = () => {
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
                const char = ['0', '1', 'A', 'F', '7', 'E'][Math.floor(Math.random() * 6)];
                particlesRef.current.push({
                    x: Math.random() * canvas.width,
                    y: Math.random() * canvas.height,
                    vx: (Math.random() - 0.5) * 0.5,
                    vy: (Math.random() - 0.5) * 0.5,
                    size: Math.random() * 3 + 1,
                    opacity: Math.random() * 0.5 + 0.2,
                    char: char,
                    color: Math.random() > 0.8 ? '#ef4444' : '#3b82f6',
                    type: Math.random() > 0.9 ? 'error' : Math.random() > 0.5 ? 'binary' : 'hex',
                    targetChar: char,
                    charChangeProgress: 0,
                    rotationSpeed: (Math.random() - 0.5) * 0.02,
                    rotation: 0
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

            // Draw matrix rain with dynamic effects
            ctx.font = '14px JetBrains Mono, monospace';
            matrixColumnsRef.current.forEach((column, index) => {
                // Randomly trigger sorting effect
                if (!column.sorting && Math.random() > 0.998) {
                    column.sorting = true;
                    column.sortProgress = 0;
                }

                // Update sorting progress
                if (column.sorting) {
                    column.sortProgress = (column.sortProgress || 0) + 0.02;
                    if (column.sortProgress >= 1) {
                        column.sorting = false;
                        // Sort chars: put binary first, then hex
                        column.chars.sort((a, b) => {
                            if (a === '0' || a === '1') return -1;
                            if (b === '0' || b === '1') return 1;
                            return 0;
                        });
                    }
                }

                column.chars.forEach((char, charIndex) => {
                    const y = column.y + charIndex * 20;
                    
                    // Character rotation during sort
                    let xOffset = 0;
                    let charRotation = 0;
                    if (column.sorting) {
                        const sortPhase = column.sortProgress || 0;
                        xOffset = Math.sin(sortPhase * Math.PI * 2 + charIndex * 0.5) * 10;
                        charRotation = Math.sin(sortPhase * Math.PI * 4 + charIndex) * 0.3;
                    }

                    if (y > 0 && y < canvas.height) {
                        // Calculate opacity based on position
                        const fadeStart = canvas.height * 0.7;
                        const opacity = y > fadeStart ? 
                            1 - (y - fadeStart) / (canvas.height - fadeStart) : 1;
                        
                        // Randomly change character
                        if (Math.random() > 0.995) {
                            column.chars[charIndex] = Math.random() > 0.5 ? 
                                '01'[Math.floor(Math.random() * 2)] : 
                                '0123456789ABCDEF'[Math.floor(Math.random() * 16)];
                        }
                        
                        // Color based on position and type
                        const isError = char === 'E' || char === 'F';
                        const isBinary = char === '0' || char === '1';
                        const hue = isError ? 0 : isBinary ? 120 : 210;
                        const lightness = 50 + (charIndex / column.chars.length) * 30;
                        
                        ctx.save();
                        ctx.translate(column.x + xOffset, y);
                        ctx.rotate(charRotation);
                        
                        ctx.fillStyle = `hsla(${hue}, 80%, ${lightness}%, ${opacity * 0.8})`;
                        ctx.fillText(char, 0, 0);
                        
                        // Glow effect for bottom chars
                        if (charIndex === column.chars.length - 1) {
                            ctx.shadowBlur = 20;
                            ctx.shadowColor = isError ? '#ef4444' : isBinary ? '#10b981' : '#3b82f6';
                            ctx.fillStyle = isError ? '#ff6b6b' : isBinary ? '#34d399' : '#60a5fa';
                            ctx.fillText(char, 0, 0);
                            ctx.shadowBlur = 0;
                        }
                        
                        ctx.restore();
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

                // Randomly trigger character change
                if (Math.random() > 0.995) {
                    const chars = particle.type === 'binary' ? ['0', '1'] : 
                                 particle.type === 'error' ? ['E', 'F', '!'] :
                                 ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'];
                    particle.targetChar = chars[Math.floor(Math.random() * chars.length)];
                    particle.charChangeProgress = 0;
                }

                // Animate character change
                if (particle.targetChar && particle.targetChar !== particle.char) {
                    particle.charChangeProgress = (particle.charChangeProgress || 0) + 0.05;
                    if (particle.charChangeProgress >= 1) {
                        particle.char = particle.targetChar;
                        particle.charChangeProgress = 0;
                    }
                }

                // Update rotation
                particle.rotation = (particle.rotation || 0) + (particle.rotationSpeed || 0);

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
                ctx.translate(particle.x, particle.y);
                
                // Apply rotation and scale during character change
                if (particle.charChangeProgress && particle.charChangeProgress > 0) {
                    const scale = 1 + Math.sin(particle.charChangeProgress * Math.PI) * 0.3;
                    ctx.scale(scale, scale);
                    ctx.rotate(particle.charChangeProgress * Math.PI * 2);
                } else {
                    ctx.rotate(particle.rotation || 0);
                }
                
                ctx.font = `${12 + particle.size * 2}px JetBrains Mono, monospace`;
                
                // Color transition during change
                if (particle.charChangeProgress && particle.charChangeProgress > 0) {
                    const t = particle.charChangeProgress;
                    ctx.fillStyle = `hsla(${120 * t + 210 * (1 - t)}, 80%, 60%, ${particle.opacity})`;
                } else {
                    ctx.fillStyle = particle.color;
                    ctx.globalAlpha = particle.opacity;
                }
                
                // Add glow for error particles
                if (particle.type === 'error' || (particle.charChangeProgress && particle.charChangeProgress > 0)) {
                    ctx.shadowBlur = 10 + (particle.charChangeProgress || 0) * 10;
                    ctx.shadowColor = particle.color;
                }
                
                // Draw character with potential scramble effect during change
                let displayChar = particle.char;
                if (particle.charChangeProgress && particle.charChangeProgress > 0 && particle.charChangeProgress < 0.5) {
                    // Show random characters during transition
                    const scrambleChars = '01234567890ABCDEF!@#$%^&*';
                    displayChar = scrambleChars[Math.floor(Math.random() * scrambleChars.length)];
                }
                
                ctx.fillText(displayChar, 0, 0);
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