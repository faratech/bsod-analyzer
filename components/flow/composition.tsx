/**
 * Continuous-composition animation engine.
 *
 * Ported from the `animations-v3.jsx` runtime that backs the "BSOD Analyzer
 * Flow" Claude Design project, trimmed to what a production page needs: the
 * authored-time axis, the scene -> cue table, <Shot>, <Captions> and the
 * easing helpers. The design-canvas host protocol (video export, the editor
 * play bar, localStorage playhead persistence, the tweaks panel) is dropped —
 * the site drives the clock itself, see `BsodAnalyzerFlow`.
 *
 * THE MODEL: the animation is ONE element tree rendered as a pure function of
 * one authored-time axis `T`. Nothing mounts or unmounts at scene boundaries,
 * so any element can move, morph or persist across them by ordinary
 * interpolation. The scene list is the only structural source — cue times are
 * derived from it, so choreography and the scene list cannot drift apart.
 */
import React, { createContext, useContext, useMemo } from 'react';

// ── Easing ──────────────────────────────────────────────────────────────────
// All easings take t ∈ [0,1] and return eased t (back overshoots past 1).
export const Easing = {
    linear: (t: number) => t,
    easeInQuad: (t: number) => t * t,
    easeOutQuad: (t: number) => t * (2 - t),
    easeInOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
    easeOutCubic: (t: number) => --t * t * t + 1,
    easeInOutCubic: (t: number) =>
        t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
    easeOutSine: (t: number) => Math.sin((t * Math.PI) / 2),
    easeInOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
    easeOutBack: (t: number) => {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
};

export const clamp = (v: number, min: number, max: number) =>
    Math.max(min, Math.min(max, v));

// ── Scenes -> cues ──────────────────────────────────────────────────────────

export interface Scene {
    /** Cue name referenced by the choreography (`CUES.Debugging`). */
    name: string;
    /** Playback seconds this scene occupies on the transport. */
    dur: number;
    /** Authored seconds, when the scene is played faster/slower than authored. */
    nat?: number;
    /** Human-readable summary — surfaced as the chapter list. */
    desc?: string;
}

interface Section {
    name: string;
    playStart: number;
    dur: number;
    authStart: number;
    nat: number;
}

export interface DerivedScenes {
    sections: Section[];
    /** Authored start time of each scene, keyed by scene name. */
    cues: Record<string, number>;
    /** Total playback length in seconds. */
    playTotal: number;
    /** Total authored length in seconds. */
    authoredTotal: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function deriveScenes(scenes: Scene[]): DerivedScenes {
    let playStart = 0;
    let authStart = 0;
    const sections: Section[] = [];
    const cues: Record<string, number> = {};
    for (const s of scenes) {
        const nat = typeof s.nat === 'number' && isFinite(s.nat) && s.nat > 0 ? s.nat : s.dur;
        sections.push({ name: s.name, playStart, dur: s.dur, authStart, nat });
        // Duplicate scene names bind to the first occurrence.
        if (!Object.prototype.hasOwnProperty.call(cues, s.name)) {
            cues[s.name] = round3(authStart);
        }
        playStart += s.dur;
        authStart += nat;
    }
    return {
        sections,
        cues,
        playTotal: round3(playStart),
        authoredTotal: round3(authStart),
    };
}

/** Map transport time onto the authored axis, honouring per-scene time warps. */
export function warpTime(d: DerivedScenes, t: number): number {
    const ss = d.sections;
    if (ss.length === 0) return 0;
    let idx = ss.length - 1;
    for (let i = 0; i < ss.length; i++) {
        if (t < ss[i].playStart + ss[i].dur) {
            idx = i;
            break;
        }
    }
    const s = ss[idx];
    const local = clamp(t - s.playStart, 0, s.dur);
    const T = s.authStart + (s.dur > 0 ? local * (s.nat / s.dur) : 0);
    return Math.min(T, d.authoredTotal);
}

// ── Composition context ─────────────────────────────────────────────────────

export interface CompositionValue {
    /** Authored seconds. Key ALL choreography to this, never to wall-clock. */
    T: number;
    /** Authored start time per scene name. */
    CUES: Record<string, number>;
    /** Transport seconds. */
    time: number;
    /** Transport length in seconds. */
    duration: number;
    playing: boolean;
}

const CompositionContext = createContext<CompositionValue | null>(null);

export function useComposition(): CompositionValue {
    const ctx = useContext(CompositionContext);
    if (!ctx) throw new Error('useComposition() must be called inside <Composition>');
    return ctx;
}

interface CompositionProps {
    derived: DerivedScenes;
    /** Transport time in seconds, driven by the host. */
    time: number;
    playing: boolean;
    children: React.ReactNode;
}

export const Composition: React.FC<CompositionProps> = ({ derived, time, playing, children }) => {
    const T = warpTime(derived, time);
    const value = useMemo<CompositionValue>(
        () => ({ T, CUES: derived.cues, time, duration: derived.playTotal, playing }),
        [T, derived, time, playing]
    );
    return <CompositionContext.Provider value={value}>{children}</CompositionContext.Provider>;
};

// ── Shot ────────────────────────────────────────────────────────────────────
// An authored hard cut in one line. Children stay mounted outside the window
// (so images keep their readiness) and are only hidden.

export const Shot: React.FC<{ from: number; to?: number; children: React.ReactNode }> = ({
    from,
    to,
    children,
}) => {
    const { T } = useComposition();
    const end = to == null ? Infinity : to;
    const on = isFinite(from) && T >= from && T < end;
    return (
        <div style={{ position: 'absolute', inset: 0, visibility: on ? 'visible' : 'hidden' }}>
            {children}
        </div>
    );
};

// ── Captions ────────────────────────────────────────────────────────────────
// ONE caption element; at most one item visible at a time, keyed to T. `until`
// defaults to the next item's `at`; a last item without `until` runs to the end.

export interface CaptionItem {
    at: number;
    until?: number;
    text: string;
}

const CAPTION_FADE = 0.18;

/** The caption active at authored time `t`, or null. Also used for the a11y transcript. */
export function activeCaption(items: CaptionItem[], t: number): { item: CaptionItem; end: number } | null {
    const sorted = items.filter((it) => it && isFinite(it.at)).sort((a, b) => a.at - b.at);
    let active: CaptionItem | null = null;
    let end = Infinity;
    for (let i = 0; i < sorted.length; i++) {
        if (t < sorted[i].at) break;
        active = sorted[i];
        end =
            typeof active.until === 'number' && isFinite(active.until)
                ? active.until
                : i + 1 < sorted.length
                  ? sorted[i + 1].at
                  : Infinity;
    }
    if (!active || t >= end) return null;
    return { item: active, end };
}

export const Captions: React.FC<{ items: CaptionItem[]; style?: React.CSSProperties }> = ({
    items,
    style,
}) => {
    const { T } = useComposition();
    const hit = activeCaption(items, T);
    if (!hit) return null;
    let o = Math.min(1, (T - hit.item.at) / CAPTION_FADE);
    if (isFinite(hit.end)) o = Math.min(o, (hit.end - T) / CAPTION_FADE);
    o = clamp(o, 0, 1);
    return (
        <div
            style={{
                position: 'absolute',
                left: '8%',
                right: '8%',
                bottom: '7%',
                textAlign: 'center',
                opacity: o,
                pointerEvents: 'none',
                ...style,
            }}
        >
            {hit.item.text}
        </div>
    );
};
