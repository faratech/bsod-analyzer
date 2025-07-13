import React, { useEffect, useRef } from 'react';

const BinaryRain: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Set canvas size
        const resizeCanvas = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        };
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        // Binary rain configuration
        const fontSize = 14;
        const columns = Math.floor(canvas.width / fontSize);
        const drops: number[] = new Array(columns).fill(1);

        // Characters to use
        const binary = '01';
        const chars = binary.split('');

        // Animation
        let animationId: number;
        const draw = () => {
            // Fade effect
            ctx.fillStyle = 'rgba(10, 10, 10, 0.05)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Set text properties
            ctx.fillStyle = '#3b82f6';
            ctx.font = `${fontSize}px JetBrains Mono, monospace`;

            // Draw characters
            for (let i = 0; i < drops.length; i++) {
                const text = chars[Math.floor(Math.random() * chars.length)];
                const x = i * fontSize;
                const y = drops[i] * fontSize;

                // Gradient effect
                const gradient = ctx.createLinearGradient(0, y - 100, 0, y);
                gradient.addColorStop(0, 'rgba(59, 130, 246, 0)');
                gradient.addColorStop(0.8, 'rgba(59, 130, 246, 0.2)');
                gradient.addColorStop(1, 'rgba(59, 130, 246, 0.6)');
                ctx.fillStyle = gradient;

                ctx.fillText(text, x, y);

                // Reset drop to top with random delay
                if (y > canvas.height && Math.random() > 0.95) {
                    drops[i] = 0;
                }
                drops[i]++;
            }

            animationId = requestAnimationFrame(draw);
        };

        draw();

        return () => {
            cancelAnimationFrame(animationId);
            window.removeEventListener('resize', resizeCanvas);
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                opacity: 0.4,
                zIndex: 1,
            }}
        />
    );
};

export default BinaryRain;