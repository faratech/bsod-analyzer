/**
 * Embeddable host for the animated pipeline diagram.
 *
 * Owns the transport that the design-canvas runtime used to own: the clock,
 * scale-to-fit, and the playback UI. Production behaviours the canvas didn't
 * need are added here — the animation only runs while it is on screen, honours
 * `prefers-reduced-motion` (it parks on the recap frame instead of playing),
 * and the narration is mirrored into a text transcript so the whole thing is
 * readable without motion.
 *
 * Responsive strategy. The piece is one 1920x1080 artboard whose camera keys
 * were authored for 16:9, so it can't be re-cropped for portrait without
 * re-authoring the composition. Instead it behaves like an embedded video:
 *   - the frame scales to fit BOTH the column width and the viewport height,
 *     so short/landscape windows never push the controls off-screen;
 *   - below ~640px of frame width the burnt-in caption would render under
 *     10px, so narration moves out of the artboard into a real text line
 *     underneath at body size ("compact" mode);
 *   - a fullscreen control gives small screens a way to see it at a legible
 *     size, which is the only thing that genuinely fixes a 1920-wide artboard
 *     on a phone.
 * Everything outside the frame — controls, chapters, transcript — is plain
 * responsive DOM and carries the full content on its own.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Composition, activeCaption, deriveScenes, warpTime } from './composition';
import BsodFlowPiece, { FLOW_SCENES, FRAME, captionItems, type Cues } from './BsodFlowPiece';

/** Below this rendered frame width the in-artboard caption stops being legible. */
const COMPACT_WIDTH = 640;
/** Share of the viewport height the frame may occupy when not fullscreen. */
const MAX_VIEWPORT_SHARE = 0.78;

const formatTime = (s: number) => {
    const total = Math.max(0, Math.round(s));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

interface BsodAnalyzerFlowProps {
    className?: string;
    /** Start playing as soon as the diagram scrolls into view. Default true. */
    autoPlay?: boolean;
}

const BsodAnalyzerFlow: React.FC<BsodAnalyzerFlowProps> = ({ className = '', autoPlay = true }) => {
    const derived = useMemo(() => deriveScenes(FLOW_SCENES), []);
    const duration = derived.playTotal;
    const transcript = useMemo(() => captionItems(derived.cues as unknown as Cues), [derived]);

    const figureRef = useRef<HTMLElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const [scale, setScale] = useState<number | null>(null);
    const [time, setTime] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [inView, setInView] = useState(false);
    const [captions, setCaptions] = useState(true);
    const [reducedMotion, setReducedMotion] = useState(false);
    const [fullscreen, setFullscreen] = useState(false);
    const [canFullscreen, setCanFullscreen] = useState(false);
    const autoStarted = useRef(false);

    // Fit the 1920x1080 frame to the column AND to the viewport height, so a
    // short or landscape window still shows the frame plus its controls.
    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const measure = () => {
            const availW = el.clientWidth;
            // Fullscreen gives the wrapper a real height to fill; otherwise cap
            // against the viewport so the frame never eats the whole screen.
            const availH = fullscreen ? el.clientHeight : window.innerHeight * MAX_VIEWPORT_SHARE;
            if (availW <= 0) return;
            setScale(Math.min(availW / FRAME.w, Math.max(availH, 200) / FRAME.h));
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        window.addEventListener('resize', measure);
        window.addEventListener('orientationchange', measure);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', measure);
            window.removeEventListener('orientationchange', measure);
        };
    }, [fullscreen]);

    // Reduced motion: never autoplay, and park on the recap frame — the one
    // still that shows the whole pipeline at once.
    useEffect(() => {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        const apply = () => {
            setReducedMotion(mq.matches);
            if (mq.matches) {
                setPlaying(false);
                setTime((t) => (t === 0 ? duration : t));
            }
        };
        apply();
        mq.addEventListener('change', apply);
        return () => mq.removeEventListener('change', apply);
    }, [duration]);

    // Only animate while on screen.
    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.35 });
        io.observe(el);
        return () => io.disconnect();
    }, []);

    // Fullscreen. Detected after mount so the control is absent from both the
    // prerendered markup and the first client render (iOS Safari has no
    // element fullscreen, so the button must not appear there at all).
    useEffect(() => {
        setCanFullscreen(Boolean(document.fullscreenEnabled));
        const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);

    const toggleFullscreen = useCallback(() => {
        const el = figureRef.current;
        if (!el) return;
        if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {});
        } else {
            void el.requestFullscreen().catch(() => {});
        }
    }, []);

    useEffect(() => {
        if (!autoPlay || reducedMotion || !inView || autoStarted.current) return;
        autoStarted.current = true;
        setPlaying(true);
    }, [autoPlay, inView, reducedMotion]);

    // The clock. `playing` is the visitor's intent; off-screen suspends it.
    const running = playing && inView;
    useEffect(() => {
        if (!running) return;
        let raf = 0;
        let last: number | null = null;
        const step = (ts: number) => {
            if (last == null) last = ts;
            const dt = (ts - last) / 1000;
            last = ts;
            setTime((t) => Math.min(duration, t + dt));
            raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [running, duration]);

    // Play once, then hold the last frame (the authored playback contract).
    useEffect(() => {
        if (playing && time >= duration) setPlaying(false);
    }, [playing, time, duration]);

    const finished = time >= duration;
    const toggle = useCallback(() => {
        if (finished) {
            setTime(0);
            setPlaying(true);
        } else {
            setPlaying((p) => !p);
        }
    }, [finished]);

    const seek = useCallback((t: number) => setTime(t), []);

    const frameW = scale === null ? 0 : FRAME.w * scale;
    // Compact = the artboard is too small to carry its own burnt-in caption.
    const compact = scale !== null && frameW < COMPACT_WIDTH;
    const liveCaption = compact && captions ? activeCaption(transcript, warpTime(derived, time)) : null;

    return (
        <figure
            ref={figureRef}
            className={`flow-figure ${fullscreen ? 'is-fullscreen' : ''} ${className}`.replace(/\s+/g, ' ').trim()}
        >
            <div className="flow-frame-wrap" ref={wrapRef}>
                <div
                    className="flow-frame"
                    aria-hidden="true"
                    style={scale === null ? undefined : { width: frameW, height: FRAME.h * scale }}
                >
                    {scale !== null && (
                        <div
                            className="flow-stage"
                            style={{ width: FRAME.w, height: FRAME.h, transform: `scale(${scale})` }}
                        >
                            <Composition derived={derived} time={time} playing={running}>
                                <BsodFlowPiece showCaptions={captions && !compact} />
                            </Composition>
                        </div>
                    )}
                    {/* Fullscreen has no spare height to stack a caption under
                        the frame, so it rides over the artboard as a subtitle. */}
                    {liveCaption && fullscreen && (
                        <p className="flow-live-caption is-overlay">{liveCaption.item.text}</p>
                    )}
                </div>
            </div>

            {compact && captions && !fullscreen && (
                <p className="flow-live-caption">{liveCaption ? liveCaption.item.text : ' '}</p>
            )}

            <div className="flow-controls">
                <button
                    type="button"
                    className="flow-btn flow-btn-play"
                    onClick={toggle}
                    aria-label={
                        finished
                            ? 'Replay the pipeline animation'
                            : playing
                              ? 'Pause the pipeline animation'
                              : 'Play the pipeline animation'
                    }
                >
                    {finished ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01" />
                            <path d="M20.5 4v5.5H15" />
                        </svg>
                    ) : playing ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <rect x="6" y="4.5" width="4" height="15" rx="1" />
                            <rect x="14" y="4.5" width="4" height="15" rx="1" />
                        </svg>
                    ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M7 4.5 19.5 12 7 19.5z" />
                        </svg>
                    )}
                    <span>{finished ? 'Replay' : playing ? 'Pause' : 'Play'}</span>
                </button>

                <input
                    type="range"
                    className="flow-scrub"
                    min={0}
                    max={duration}
                    step={0.05}
                    value={time}
                    onChange={(e) => seek(Number(e.target.value))}
                    aria-label="Seek the pipeline animation"
                />

                <span className="flow-time">
                    {formatTime(time)} / {formatTime(duration)}
                </span>

                <button
                    type="button"
                    className={`flow-btn flow-btn-toggle ${captions ? 'is-on' : ''}`.trim()}
                    onClick={() => setCaptions((c) => !c)}
                    aria-pressed={captions}
                >
                    Captions
                </button>

                {canFullscreen && (
                    <button
                        type="button"
                        className="flow-btn flow-btn-icon"
                        onClick={toggleFullscreen}
                        aria-label={fullscreen ? 'Exit fullscreen' : 'View the animation fullscreen'}
                        title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            {fullscreen ? (
                                <path d="M9 3.5v5.5H3.5M15 20.5V15h5.5M20.5 9H15V3.5M3.5 15H9v5.5" />
                            ) : (
                                <path d="M8.5 3.5H3.5V8.5M15.5 3.5h5v5M20.5 15.5v5h-5M8.5 20.5h-5v-5" />
                            )}
                        </svg>
                    </button>
                )}
            </div>

            <ol className="flow-chapters">
                {derived.sections.map((s, i) => {
                    const scene = FLOW_SCENES[i];
                    const active = time >= s.playStart && time < s.playStart + s.dur;
                    return (
                        <li key={s.name}>
                            <button
                                type="button"
                                className={`flow-chapter ${active ? 'is-active' : ''}`.trim()}
                                onClick={() => seek(s.playStart)}
                            >
                                <span className="flow-chapter-name">
                                    {i + 1}. {s.name}
                                </span>
                                <span className="flow-chapter-desc">{scene.desc}</span>
                            </button>
                        </li>
                    );
                })}
            </ol>

            <figcaption className="flow-caption">
                How a crash dump travels through bsod.windowsforum.com — from the blue screen on your PC to a
                plain-English report in your browser.
                {reducedMotion ? ' Playback is paused because your system asks for reduced motion.' : ''}
            </figcaption>

            <details className="flow-transcript">
                <summary>Transcript</summary>
                <ol>
                    {transcript.map((c) => (
                        <li key={c.at}>{c.text}</li>
                    ))}
                </ol>
            </details>
        </figure>
    );
};

export default BsodAnalyzerFlow;
