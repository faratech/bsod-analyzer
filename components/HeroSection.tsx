import React, { useEffect, useRef, useState, Suspense } from 'react';
const LazyHeroAnimation = React.lazy(() => import('./HeroAnimation'));
import AnimatedBackground from './AnimatedBackground';

interface HeroSectionProps {
    title: string;
    subtitle: string;
    backgroundType?: 'animated' | 'grid';
    className?: string;
    children?: React.ReactNode;
    actions?: React.ReactNode;
    /**
     * When true, the hero animation will not render on devices that appear to
     * have limited resources or when the user prefers reduced motion.
     */
    disableAnimationOnLowPower?: boolean;
}

const HeroSection: React.FC<HeroSectionProps> = ({
    title,
    subtitle,
    backgroundType = 'grid',
    className = '',
    children,
    actions,
    disableAnimationOnLowPower = false
}) => {
    const sectionRef = useRef<HTMLElement | null>(null);
    const [showAnimation, setShowAnimation] = useState(false);

    useEffect(() => {
        if (typeof window === 'undefined') return;

        let disabled = false;
        if (disableAnimationOnLowPower) {
            const cores = (navigator as any).hardwareConcurrency || 0;
            const prefersReduced =
                typeof window !== 'undefined' &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if ((cores && cores <= 2) || prefersReduced) {
                disabled = true;
            }
        }

        if (disabled) return;

        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setShowAnimation(true);
                    observer.disconnect();
                }
            },
            { threshold: 0.1 }
        );
        if (sectionRef.current) {
            observer.observe(sectionRef.current);
        }
        return () => {
            observer.disconnect();
        };
    }, [disableAnimationOnLowPower]);

    return (
        <section ref={sectionRef} className={`hero ${className}`}>
            {backgroundType === 'animated' && <AnimatedBackground />}
            {backgroundType === 'grid' && (
                <div className="hero-background">
                    <div className="hero-grid"></div>
                    {showAnimation && (
                        <Suspense fallback={null}>
                            <LazyHeroAnimation />
                        </Suspense>
                    )}
                </div>
            )}
            
            <div className="container">
                <div className="hero-content fade-in">
                    <h1 className="hero-title">{title}</h1>
                    <p className="hero-subtitle">{subtitle}</p>
                    
                    {actions && (
                        <div className="hero-actions">
                            {actions}
                        </div>
                    )}
                    
                    {children}
                </div>
            </div>
        </section>
    );
};

export default HeroSection;