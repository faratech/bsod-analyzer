/**
 * BSOD AI Analyzer — animated pipeline diagram.
 *
 * Ported from `bsod-flow.jsx` in the "BSOD Analyzer Flow" Claude Design
 * project. One element tree rendered as a pure function of authored time `T`
 * (see `composition.tsx`); a virtual camera pans and zooms a 3800x1800 world
 * inside a 1920x1080 frame.
 *
 * Visual language is the WindowsForum design system, not this site's chrome:
 * the piece depicts the WindowsForum-branded product, so it keeps the Fluent
 * light palette, the two-layer block shadow and the 24H4 wallpaper regardless
 * of the visitor's theme — the same way an embedded screencast would.
 */
import React from 'react';
import { Captions, Easing, Shot, clamp, useComposition, type CaptionItem } from './composition';
import { FlowIcon, type FlowIconName } from './icons';

// ── Design-system constants ─────────────────────────────────────────────────
const C = {
    blue: '#0f6cbd',
    navy: '#07426f',
    accent: '#115ea3',
    ink: '#1a1b1b',
    grey: '#5f6060',
    hair: '#ebebeb',
    card: '#ffffff',
    bsod: '#0078D7',
};
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = 'Consolas, "Lucida Console", monospace';
const SHADOW = 'rgba(0,0,0,0.132) 0 1.6px 3.6px 0, rgba(0,0,0,0.11) 0 0.3px 0.9px 0';
const MENU_SHADOW = '0 4px 12px rgba(0,0,0,0.18)';

export const WORLD = { w: 3800, h: 1800 };
export const FRAME = { w: 1920, h: 1080 };

/** Authored scene list — the single structural source for every cue below. */
export const FLOW_SCENES = [
    { name: 'Crash', dur: 7, desc: 'A PC blue-screens and Windows saves a crash dump file' },
    { name: 'Upload', dur: 10, desc: 'The dump is dropped into bsod.windowsforum.com and uploads' },
    { name: 'Handoff', dur: 9, desc: 'The browser hands the file to the WindowsForum server, which checks it' },
    { name: 'Debugging', dur: 16, desc: 'A real Windows debugger opens the dump with Microsoft symbols and finds the culprit' },
    { name: 'Progress', dur: 7, desc: 'The browser polls for status every ten seconds while the analysis runs' },
    { name: 'AI', dur: 12, desc: 'An AI interpreter turns raw debugger output into a plain-English report' },
    { name: 'Report', dur: 9, desc: 'The finished report travels back and appears in the browser' },
    { name: 'Recap', dur: 5, desc: 'The whole pipeline in one view: upload, debug, interpret, report' },
];

export interface Cues {
    Crash: number;
    Upload: number;
    Handoff: number;
    Debugging: number;
    Progress: number;
    AI: number;
    Report: number;
    Recap: number;
}

// The only three motion helpers.
const MOTION = {
    enter(T: number, start: number, dur?: number): React.CSSProperties {
        const p = clamp((T - start) / (dur || 0.6), 0, 1);
        const e = Easing.easeOutCubic(p);
        return { opacity: e, transform: `translateY(${(1 - e) * 22}px)` };
    },
    pop(T: number, start: number, dur?: number): React.CSSProperties {
        const p = clamp((T - start) / (dur || 0.5), 0, 1);
        return { opacity: p < 0.02 ? 0 : 1, transform: `scale(${Easing.easeOutBack(p)})` };
    },
    draw(T: number, start: number, dur?: number) {
        return Easing.easeInOutCubic(clamp((T - start) / (dur || 1.2), 0, 1));
    },
};

// ── World geometry (3800 x 1800) ────────────────────────────────────────────
type Pt = [number, number];
const SCREEN = { w: 960, h: 540 };
const A_PC: Pt = [1206, 730];
const A_SRV_L: Pt = [1645, 730];
const A_SRV_R: Pt = [2135, 700];
const A_SRV_B: Pt = [1950, 925];
const A_WDB_L: Pt = [2555, 645];
const A_AI: Pt = [2610, 1300];
const QSLOT: Pt = [2667, 452];
const CONSOLE_IN: Pt = [2990, 560];

type CamKey = [number, number, number, number]; // [T, cx, cy, scale]

function camAt(T: number, keys: CamKey[]) {
    if (T <= keys[0][0]) {
        const k = keys[0];
        return { cx: k[1], cy: k[2], s: k[3] };
    }
    for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i];
        const b = keys[i + 1];
        if (T <= b[0]) {
            const p = Easing.easeInOutCubic(clamp((T - a[0]) / (b[0] - a[0] || 1), 0, 1));
            return {
                cx: a[1] + (b[1] - a[1]) * p,
                cy: a[2] + (b[2] - a[2]) * p,
                s: a[3] + (b[3] - a[3]) * p,
            };
        }
    }
    const k = keys[keys.length - 1];
    return { cx: k[1], cy: k[2], s: k[3] };
}

function pathPos(T: number, wps: { t: number; p: Pt }[]): Pt {
    if (T <= wps[0].t) return wps[0].p;
    for (let i = 0; i < wps.length - 1; i++) {
        const a = wps[i];
        const b = wps[i + 1];
        if (T <= b.t) {
            const p = Easing.easeInOutCubic(clamp((T - a.t) / (b.t - a.t || 1), 0, 1));
            return [a.p[0] + (b.p[0] - a.p[0]) * p, a.p[1] + (b.p[1] - a.p[1]) * p];
        }
    }
    return wps[wps.length - 1].p;
}

function typed(T: number, start: number, txt: string, cps?: number) {
    return txt.slice(0, Math.max(0, Math.floor((T - start) * (cps || 28))));
}

// ── Small building blocks ───────────────────────────────────────────────────
const BlockHeader: React.FC<{ icon: FlowIconName; text: string; sub?: string }> = ({ icon, text, sub }) => (
    <div
        style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '16px 20px',
            borderBottom: `1px solid ${C.hair}`,
            background: C.blue,
            borderRadius: '8px 8px 0 0',
        }}
    >
        <FlowIcon name={icon} size={24} color="#fff" />
        <div>
            <div style={{ font: `700 26px ${FONT}`, color: '#fff' }}>{text}</div>
            {sub ? (
                <div style={{ font: `400 17px ${FONT}`, color: 'rgba(255,255,255,0.85)', marginTop: 2 }}>{sub}</div>
            ) : null}
        </div>
    </div>
);

const Row: React.FC<{ icon: FlowIconName; text: string; active: boolean }> = ({ icon, text, active }) => (
    <div
        style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '14px 16px',
            borderRadius: 4,
            background: active ? 'rgba(15,108,189,0.12)' : 'transparent',
            border: `1px solid ${active ? 'rgba(15,108,189,0.35)' : 'transparent'}`,
        }}
    >
        <div style={{ width: 28, display: 'flex', justifyContent: 'center' }}>
            <FlowIcon name={icon} size={22} color={active ? C.blue : C.grey} />
        </div>
        <span style={{ font: `${active ? 700 : 400} 22px ${FONT}`, color: C.ink }}>{text}</span>
        {active ? (
            <div style={{ marginLeft: 'auto' }}>
                <FlowIcon name="checkCircle" size={20} color={C.blue} />
            </div>
        ) : null}
    </div>
);

const Chip: React.FC<{
    x: number;
    y: number;
    scale?: number;
    opacity: number;
    icon: FlowIconName;
    label: string;
    dark?: boolean;
}> = ({ x, y, scale, opacity, icon, label, dark }) => {
    if (opacity <= 0.01) return null;
    return (
        <div
            style={{
                position: 'absolute',
                left: x,
                top: y,
                transform: `translate(-50%,-50%) scale(${scale == null ? 1 : scale})`,
                opacity,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: dark ? '#1e1e1e' : '#fff',
                border: `1px solid ${dark ? '#333' : C.hair}`,
                borderRadius: 6,
                padding: '10px 18px',
                boxShadow: MENU_SHADOW,
                whiteSpace: 'nowrap',
            }}
        >
            <FlowIcon name={icon} size={20} color={dark ? '#9ecbf0' : C.blue} />
            <span style={{ font: `700 21px ${MONO}`, color: dark ? '#e8e8e8' : C.ink }}>{label}</span>
        </div>
    );
};

// ── Screen states (inside the monitor) ──────────────────────────────────────
const BsodScreen: React.FC<{ T: number }> = ({ T }) => {
    const pct = clamp(Math.floor(((T - 1.2) / 4.0) * 100), 0, 100);
    return (
        <div
            style={{
                position: 'absolute',
                inset: 0,
                background: C.bsod,
                color: '#fff',
                padding: '56px 70px',
                fontFamily: FONT,
            }}
        >
            <div style={{ font: `300 120px ${FONT}` }}>:(</div>
            <div style={{ font: `300 27px ${FONT}`, marginTop: 26, lineHeight: 1.45, maxWidth: 700 }}>
                Your PC ran into a problem and needs to restart. We&rsquo;re just collecting some error info.
            </div>
            <div style={{ font: `300 25px ${FONT}`, marginTop: 26 }}>{pct}% complete</div>
            <div style={{ font: `400 15px ${MONO}`, marginTop: 44, opacity: 0.85 }}>
                Stop code: DRIVER_IRQL_NOT_LESS_OR_EQUAL
            </div>
            <div
                style={{
                    position: 'absolute',
                    right: 40,
                    bottom: 36,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    background: '#fff',
                    borderRadius: 6,
                    padding: '10px 16px',
                    boxShadow: MENU_SHADOW,
                    ...MOTION.pop(T, 5.2),
                }}
            >
                <FlowIcon name="fileCheck" size={18} color={C.blue} />
                <span style={{ font: `700 16px ${MONO}`, color: C.ink }}>MEMORY.DMP saved</span>
            </div>
        </div>
    );
};

const Cursor: React.FC<{ x: number; y: number; opacity: number }> = ({ x, y, opacity }) => (
    <svg
        width="26"
        height="30"
        viewBox="0 0 13 15"
        style={{ position: 'absolute', left: x, top: y, opacity, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))' }}
    >
        <path d="M1 1 L1 12 L4 9.5 L6 14 L8 13 L6 8.7 L10 8.5 Z" fill="#fff" stroke="#1a1b1b" strokeWidth="0.8" />
    </svg>
);

const BrowserChrome: React.FC = () => (
    <>
        <div
            style={{
                height: 46,
                background: '#f1f3f4',
                borderBottom: `1px solid ${C.hair}`,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '0 16px',
            }}
        >
            <div style={{ display: 'flex', gap: 7 }}>
                {[0, 1, 2].map((i) => (
                    <div key={i} style={{ width: 11, height: 11, borderRadius: 999, background: '#d9dcdf' }} />
                ))}
            </div>
            <div
                style={{
                    flex: 1,
                    height: 28,
                    background: '#fff',
                    borderRadius: 999,
                    border: `1px solid ${C.hair}`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '0 14px',
                }}
            >
                <FlowIcon name="lock" size={11} color={C.grey} />
                <span style={{ font: `400 14px ${FONT}`, color: C.ink }}>bsod.windowsforum.com</span>
            </div>
        </div>
        <div style={{ height: 52, background: C.blue, display: 'flex', alignItems: 'center', gap: 12, padding: '0 22px' }}>
            <img src="/flow/windowsforum.svg" alt="" style={{ height: 22 }} />
            <span
                style={{
                    font: `400 16px ${FONT}`,
                    color: 'rgba(255,255,255,0.75)',
                    borderLeft: '1px solid rgba(255,255,255,0.35)',
                    paddingLeft: 12,
                }}
            >
                BSOD AI Analyzer
            </span>
        </div>
    </>
);

const BrowserScreen: React.FC<{ T: number; K: Cues }> = ({ T, K }) => {
    const U = K.Upload;
    const dragP = Easing.easeInOutCubic(clamp((T - (U + 2)) / 2, 0, 1));
    const dropped = T >= U + 4;
    const upP = clamp((T - (U + 4.5)) / 3, 0, 1);
    const uploaded = T >= U + 7.6;
    const chipX = 120 + (410 - 120) * dragP;
    const chipY = 468 + (322 - 468) * dragP;
    const stepIdx = T < K.Handoff + 6 ? 0 : T < K.Debugging + 3.5 ? 1 : T < K.AI + 2 ? 2 : 3;
    const steps = ['Uploaded', 'Queued', 'Debugging', 'Report'];
    return (
        <div style={{ position: 'absolute', inset: 0, background: '#fff', fontFamily: FONT, ...MOTION.enter(T, U + 0.35, 0.8) }}>
            <BrowserChrome />
            <div style={{ padding: '26px 60px', textAlign: 'center' }}>
                <div style={{ font: `700 27px ${FONT}`, color: C.ink }}>Upload a crash dump</div>
                <div style={{ font: `400 16px ${FONT}`, color: C.grey, marginTop: 4 }}>
                    We&rsquo;ll tell you what crashed and why — in plain English.
                </div>
                <div
                    style={{
                        margin: '20px auto 0',
                        width: 620,
                        height: 210,
                        border: `2px dashed ${dropped ? C.blue : '#b9c4cc'}`,
                        borderRadius: 8,
                        background: dropped ? 'rgba(15,108,189,0.06)' : '#fbfcfd',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 10,
                        position: 'relative',
                        overflow: 'hidden',
                    }}
                >
                    {!dropped ? (
                        <>
                            <FlowIcon name="cloudUpload" size={44} color={C.blue} />
                            <div style={{ font: `700 20px ${FONT}`, color: C.ink }}>Drop your .dmp file here</div>
                            <div style={{ font: `400 15px ${FONT}`, color: C.grey }}>up to 500 MB — .dmp, .zip, .7z, .rar</div>
                        </>
                    ) : (
                        <div style={{ width: 520 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <FlowIcon name="fileShield" size={28} color={C.blue} />
                                <div style={{ textAlign: 'left', flex: 1 }}>
                                    <div style={{ font: `700 17px ${MONO}`, color: C.ink }}>MEMORY.DMP</div>
                                    <div style={{ font: `400 14px ${FONT}`, color: C.grey }}>1.2 GB — kernel memory dump</div>
                                </div>
                                {uploaded ? (
                                    <span
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 7,
                                            font: `700 15px ${FONT}`,
                                            color: C.blue,
                                        }}
                                    >
                                        <FlowIcon name="checkCircle" size={15} color={C.blue} />
                                        Uploaded
                                    </span>
                                ) : (
                                    <span style={{ font: `700 15px ${FONT}`, color: C.grey }}>{Math.floor(upP * 100)}%</span>
                                )}
                            </div>
                            <div style={{ height: 8, background: C.hair, borderRadius: 999, marginTop: 14, overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${upP * 100}%`, background: C.blue }} />
                            </div>
                        </div>
                    )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 34, marginTop: 22, ...MOTION.enter(T, U + 8.6) }}>
                    {steps.map((s, i) => (
                        <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div
                                style={{
                                    width: 20,
                                    height: 20,
                                    borderRadius: 999,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    background: i < stepIdx ? C.blue : i === stepIdx ? '#fff' : C.hair,
                                    border: i === stepIdx ? `3px solid ${C.blue}` : 'none',
                                }}
                            >
                                {i < stepIdx ? (
                                    <FlowIcon name="check" size={10} color="#fff" />
                                ) : i === stepIdx ? (
                                    <div
                                        style={{
                                            width: 8,
                                            height: 8,
                                            borderRadius: 999,
                                            background: C.blue,
                                            transform: `scale(${0.7 + 0.3 * Math.abs(Math.sin(T * 2.6))})`,
                                        }}
                                    />
                                ) : null}
                            </div>
                            <span style={{ font: `${i === stepIdx ? 700 : 400} 15px ${FONT}`, color: i <= stepIdx ? C.ink : C.grey }}>
                                {s}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
            {T < U + 4.2 ? <Cursor x={chipX + 96} y={chipY + 30} opacity={T > U + 1.6 ? 1 : 0} /> : null}
            {T < U + 4.2 ? (
                <div
                    style={{
                        position: 'absolute',
                        left: chipX,
                        top: chipY,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                        background: '#fff',
                        border: `1px solid ${C.hair}`,
                        borderRadius: 6,
                        padding: '9px 15px',
                        boxShadow: MENU_SHADOW,
                        ...(T < U + 1.9 ? MOTION.pop(T, U + 1.2) : {}),
                    }}
                >
                    <FlowIcon name="file" size={17} color={C.blue} />
                    <span style={{ font: `700 15px ${MONO}`, color: C.ink }}>MEMORY.DMP</span>
                </div>
            ) : null}
        </div>
    );
};

const ReportScreen: React.FC<{ T: number; K: Cues }> = ({ T, K }) => {
    const R = K.Report + 4;
    const bullets = [
        'Update your Wi-Fi driver from your PC maker’s site',
        'Install pending Windows updates',
        'If it repeats, roll back the most recent driver update',
    ];
    return (
        <div style={{ position: 'absolute', inset: 0, background: '#fff', fontFamily: FONT }}>
            <BrowserChrome />
            <div style={{ padding: '24px 70px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, ...MOTION.pop(T, R + 0.4) }}>
                    <div
                        style={{
                            width: 40,
                            height: 40,
                            borderRadius: 999,
                            background: C.blue,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <FlowIcon name="check" size={19} color="#fff" />
                    </div>
                    <div style={{ font: `700 27px ${FONT}`, color: C.ink }}>Analysis complete</div>
                </div>
                <div
                    style={{
                        marginTop: 16,
                        background: '#fff',
                        border: `1px solid ${C.hair}`,
                        borderRadius: 8,
                        boxShadow: SHADOW,
                        padding: '18px 24px',
                        ...MOTION.enter(T, R + 0.8),
                    }}
                >
                    <div style={{ font: `400 14px ${FONT}`, color: C.grey, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        Probable cause
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
                        <span style={{ font: `700 22px ${FONT}`, color: C.ink }}>Network driver</span>
                        <span
                            style={{
                                font: `700 17px ${MONO}`,
                                color: C.blue,
                                background: 'rgba(15,108,189,0.1)',
                                padding: '4px 10px',
                                borderRadius: 4,
                            }}
                        >
                            netwtw10.sys
                        </span>
                    </div>
                    <div style={{ font: `400 16px ${FONT}`, color: C.ink, marginTop: 10, lineHeight: 1.45, ...MOTION.enter(T, R + 1.3) }}>
                        Your Wi-Fi driver tried to use memory it wasn&rsquo;t allowed to touch, and Windows shut down to protect your
                        data.
                    </div>
                    <div style={{ borderTop: `1px solid ${C.hair}`, marginTop: 14, paddingTop: 12 }}>
                        <div style={{ font: `400 14px ${FONT}`, color: C.grey, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                            What to do next
                        </div>
                        {bullets.map((b, i) => (
                            <div
                                key={i}
                                style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 9, ...MOTION.enter(T, R + 1.8 + i * 0.5) }}
                            >
                                <FlowIcon name="wrench" size={14} color={C.blue} />
                                <span style={{ font: `400 16px ${FONT}`, color: C.ink }}>{b}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

// ── World nodes ─────────────────────────────────────────────────────────────
const PcNode: React.FC<{ T: number; K: Cues }> = ({ T, K }) => (
    <div style={{ position: 'absolute', left: 170, top: 430 }}>
        <div
            style={{
                width: 1020,
                height: 600,
                background: '#e3e7ea',
                border: '1px solid #c9d0d6',
                borderRadius: 14,
                padding: 30,
                boxShadow: MENU_SHADOW,
            }}
        >
            <div style={{ position: 'relative', width: SCREEN.w, height: SCREEN.h, background: '#0a0a0c', borderRadius: 4, overflow: 'hidden' }}>
                <Shot from={0} to={K.Upload + 0.2}>
                    <BsodScreen T={T} />
                </Shot>
                <Shot from={K.Upload + 0.2} to={K.Report + 4}>
                    <BrowserScreen T={T} K={K} />
                </Shot>
                <Shot from={K.Report + 4}>
                    <ReportScreen T={T} K={K} />
                </Shot>
            </div>
        </div>
        <div style={{ width: 150, height: 70, background: '#d3d9de', margin: '0 auto', clipPath: 'polygon(18% 0, 82% 0, 100% 100%, 0 100%)' }} />
        <div style={{ width: 340, height: 14, background: '#c9d0d6', borderRadius: 999, margin: '0 auto' }} />
        <div style={{ textAlign: 'center', marginTop: 18, font: `700 30px ${FONT}`, color: C.ink }}>Your PC</div>
    </div>
);

const ServerNode: React.FC<{ T: number; K: Cues }> = ({ T, K }) => {
    const checking = T >= K.Handoff + 6 && T <= K.Handoff + 8.5;
    const coordinating = (T >= K.Handoff + 8 && T <= K.Debugging + 2.5) || (T >= K.AI + 1 && T <= K.AI + 4.5);
    const returning = T >= K.Report + 1.5 && T <= K.Report + 4.5;
    return (
        <div style={{ position: 'absolute', left: 1650, top: 560, width: 480, background: C.card, borderRadius: 8, boxShadow: SHADOW }}>
            <BlockHeader icon="server" text="WindowsForum server" sub="bsod.windowsforum.com" />
            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Row icon="shield" text="Checks the upload is safe" active={checking} />
                <Row icon="route" text="Coordinates the analysis" active={coordinating} />
                <Row icon="send" text="Returns your report" active={returning} />
            </div>
        </div>
    );
};

const WindbgNode: React.FC<{ T: number; K: Cues }> = ({ T, K }) => {
    const D = K.Debugging;
    const lines: { t: number; txt: string; hl?: boolean }[] = [
        { t: D + 6.6, txt: 'Microsoft (R) Windows Debugger — kernel mode' },
        { t: D + 7.4, txt: '> Opening MEMORY.DMP  (kernel memory dump)' },
        { t: D + 8.5, txt: '> Loading Microsoft symbols… ntoskrnl.exe  hal.dll' },
        { t: D + 10.4, txt: '> Rebuilding the moment of the crash…' },
        { t: D + 11.9, txt: '> Stack: nt!KeBugCheckEx  <-  netwtw10.sys+0x41c2' },
        { t: D + 13.4, txt: 'Probably caused by : netwtw10.sys (Wi-Fi driver)', hl: true },
    ];
    const symActive = T >= D + 8.5 && T <= D + 11;
    const inSlot = T >= D + 3.2 && T < D + 5.6;
    return (
        <div style={{ position: 'absolute', left: 2560, top: 260, width: 860, background: C.card, borderRadius: 8, boxShadow: SHADOW }}>
            <BlockHeader icon="microchip" text="Debugging server" sub="a Windows machine running real crash-debugging tools" />
            <div style={{ position: 'relative', padding: '20px 40px 30px', height: 596 }}>
                <div
                    style={{
                        position: 'absolute',
                        left: 40,
                        top: 20,
                        width: 380,
                        background: '#fbfcfd',
                        border: `1px solid ${C.hair}`,
                        borderRadius: 8,
                        padding: 16,
                    }}
                >
                    <div style={{ font: `700 19px ${FONT}`, color: C.ink }}>Job queue</div>
                    <div style={{ display: 'flex', gap: 14, marginTop: 12 }}>
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                style={{
                                    width: 102,
                                    height: 74,
                                    border: `2px ${i === 0 && inSlot ? 'solid' : 'dashed'} ${i === 0 && inSlot ? C.blue : '#c6d0d8'}`,
                                    borderRadius: 6,
                                    background: i === 0 && inSlot ? 'rgba(15,108,189,0.08)' : 'transparent',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}
                            >
                                {i === 0 && inSlot ? (
                                    <FlowIcon name="file" size={24} color={C.blue} />
                                ) : (
                                    <span style={{ font: `400 14px ${FONT}`, color: '#b0bcc4' }}>empty</span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
                <div
                    style={{
                        position: 'absolute',
                        left: 460,
                        top: 20,
                        width: 360,
                        border: `2px solid ${symActive ? C.blue : C.hair}`,
                        borderRadius: 8,
                        background: symActive ? 'rgba(15,108,189,0.06)' : '#fbfcfd',
                        padding: 16,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 16,
                    }}
                >
                    <FlowIcon name="database" size={34} color={symActive ? C.blue : C.grey} />
                    <div>
                        <div style={{ font: `700 19px ${FONT}`, color: C.ink }}>Microsoft symbol library</div>
                        <div style={{ font: `400 15px ${FONT}`, color: C.grey, marginTop: 3 }}>
                            reference data matched to your exact Windows build
                        </div>
                    </div>
                </div>
                {symActive ? (
                    <div
                        style={{
                            position: 'absolute',
                            left: 630,
                            top: 128 + ((T * 1.4) % 1) * 120,
                            width: 10,
                            height: 10,
                            borderRadius: 999,
                            background: C.blue,
                        }}
                    />
                ) : null}
                <div
                    style={{
                        position: 'absolute',
                        left: 40,
                        top: 276,
                        width: 780,
                        height: 300,
                        background: '#1e1e1e',
                        borderRadius: 8,
                        overflow: 'hidden',
                        boxShadow: MENU_SHADOW,
                    }}
                >
                    <div style={{ height: 40, background: '#2d2d30', display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px' }}>
                        <FlowIcon name="terminal" size={14} color="#9ecbf0" />
                        <span style={{ font: `400 15px ${MONO}`, color: '#c8c8c8' }}>cdb.exe — crash debugger</span>
                    </div>
                    <div style={{ padding: '14px 18px' }}>
                        {lines.map((l, i) => {
                            const shown = typed(T, l.t, l.txt);
                            if (!shown) return null;
                            return (
                                <div
                                    key={i}
                                    style={{
                                        font: `400 19px ${MONO}`,
                                        lineHeight: '34px',
                                        whiteSpace: 'pre',
                                        color: l.hl ? '#fff' : '#c9d8e4',
                                        background: l.hl ? C.accent : 'transparent',
                                        padding: l.hl ? '2px 8px' : '2px 0',
                                        borderRadius: 3,
                                        display: 'inline-block',
                                        width: l.hl ? 'auto' : '100%',
                                    }}
                                >
                                    {shown}
                                    {shown.length < l.txt.length ? '▌' : ''}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
};

const AiNode: React.FC<{ T: number; K: Cues }> = ({ T, K }) => {
    const A = K.AI;
    const arrowP = MOTION.draw(T, A + 5.2, 1);
    const outLines = [180, 150, 165];
    return (
        <div style={{ position: 'absolute', left: 2620, top: 1180, width: 620, background: C.card, borderRadius: 8, boxShadow: SHADOW }}>
            <BlockHeader icon="sparkles" text="AI interpreter" sub="turns debugger output into plain English" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '22px 26px' }}>
                <div style={{ width: 190, ...MOTION.pop(T, A + 4.4) }}>
                    <div style={{ background: '#1e1e1e', borderRadius: 6, padding: '12px 14px', boxShadow: SHADOW }}>
                        {[150, 160, 120, 155, 130, 145].map((w, i) => (
                            <div key={i} style={{ height: 7, width: w * 0.9, background: '#4b5b68', borderRadius: 999, marginTop: i ? 8 : 0 }} />
                        ))}
                    </div>
                    <div style={{ font: `400 15px ${FONT}`, color: C.grey, textAlign: 'center', marginTop: 8 }}>raw debugger output</div>
                </div>
                <svg width="120" height="40" viewBox="0 0 120 40" style={{ flexShrink: 0 }}>
                    <line x1="6" y1="20" x2={6 + 92 * arrowP} y2="20" stroke={C.blue} strokeWidth="5" strokeLinecap="round" />
                    {arrowP > 0.95 ? <polygon points="98,10 116,20 98,30" fill={C.blue} /> : null}
                </svg>
                <div style={{ width: 210, ...MOTION.pop(T, A + 6.6) }}>
                    <div style={{ background: '#fff', border: `1px solid ${C.hair}`, borderRadius: 6, padding: '12px 14px', boxShadow: SHADOW }}>
                        <div style={{ height: 12, width: 130, background: C.blue, borderRadius: 3 }} />
                        {outLines.map((w, i) => (
                            <div
                                key={i}
                                style={{
                                    height: 8,
                                    width: w * clamp((T - (A + 7) - i * 0.5) / 0.7, 0, 1),
                                    background: C.hair,
                                    borderRadius: 999,
                                    marginTop: 10,
                                }}
                            />
                        ))}
                    </div>
                    <div style={{ font: `400 15px ${FONT}`, color: C.grey, textAlign: 'center', marginTop: 8 }}>plain-English report</div>
                </div>
            </div>
        </div>
    );
};

// ── Connectors, packets, recap ──────────────────────────────────────────────
const Wires: React.FC<{ T: number; K: Cues }> = ({ T, K }) => {
    const segs: { a: Pt; b: Pt; t: number; d: number }[] = [
        { a: A_PC, b: A_SRV_L, t: K.Handoff + 1, d: 1.4 },
        { a: A_SRV_R, b: A_WDB_L, t: K.Handoff + 7.4, d: 1.4 },
        { a: A_SRV_B, b: A_AI, t: K.AI + 1.2, d: 1.6 },
    ];
    return (
        <svg width={WORLD.w} height={WORLD.h} style={{ position: 'absolute', left: 0, top: 0 }}>
            {segs.map((s, i) => {
                const p = MOTION.draw(T, s.t, s.d);
                if (p <= 0) return null;
                const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
                const ang = (Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]) * 180) / Math.PI;
                return (
                    <g key={i}>
                        <line
                            x1={s.a[0]}
                            y1={s.a[1]}
                            x2={s.b[0]}
                            y2={s.b[1]}
                            stroke={C.blue}
                            strokeWidth="6"
                            strokeDasharray={len}
                            strokeDashoffset={len * (1 - p)}
                            strokeLinecap="round"
                            opacity="0.85"
                        />
                        {p > 0.97 ? (
                            <polygon points="-2,-11 20,0 -2,11" fill={C.blue} transform={`translate(${s.b[0]},${s.b[1]}) rotate(${ang})`} />
                        ) : null}
                    </g>
                );
            })}
        </svg>
    );
};

const Packets: React.FC<{ T: number; K: Cues }> = ({ T, K }) => {
    // dump chip: PC -> server -> debugging server -> queue -> console
    const dumpWps: { t: number; p: Pt }[] = [
        { t: K.Handoff + 2.5, p: A_PC },
        { t: K.Handoff + 6, p: [1885, 733] },
        { t: K.Handoff + 8, p: [2120, 705] },
        { t: K.Debugging + 2, p: A_WDB_L },
        { t: K.Debugging + 3.4, p: QSLOT },
        { t: K.Debugging + 5.2, p: QSLOT },
        { t: K.Debugging + 6.4, p: CONSOLE_IN },
    ];
    const dumpOn = T >= K.Handoff + 2.2 && T <= K.Debugging + 6.6;
    const dp = pathPos(T, dumpWps);
    const dumpOp = dumpOn
        ? Math.min(
              clamp((T - (K.Handoff + 2.2)) / 0.4, 0, 1),
              T >= K.Debugging + 3.0 && T < K.Debugging + 5.8 ? 0 : 1,
              clamp((K.Debugging + 6.6 - T) / 0.4, 0, 1)
          )
        : 0;
    // raw output doc: console -> server -> AI
    const rawWps: { t: number; p: Pt }[] = [
        { t: K.Progress + 5.5, p: [3200, 900] },
        { t: K.Progress + 6.6, p: A_WDB_L },
        { t: K.AI + 1.5, p: [2135, 705] },
        { t: K.AI + 2.1, p: A_SRV_B },
        { t: K.AI + 4.4, p: A_AI },
    ];
    const rawOn = T >= K.Progress + 5.2 && T <= K.AI + 4.6;
    const rp = pathPos(T, rawWps);
    const rawOp = rawOn ? Math.min(clamp((T - (K.Progress + 5.2)) / 0.4, 0, 1), clamp((K.AI + 4.6 - T) / 0.4, 0, 1)) : 0;
    // report doc: AI -> server -> PC
    const repWps: { t: number; p: Pt }[] = [
        { t: K.AI + 11.4, p: [3000, 1330] },
        { t: K.Report + 1.8, p: A_SRV_B },
        { t: K.Report + 2.3, p: [1885, 733] },
        { t: K.Report + 4, p: [1010, 730] },
    ];
    const repOn = T >= K.AI + 11.1 && T <= K.Report + 4.1;
    const pp = pathPos(T, repWps);
    const repOp = repOn ? Math.min(clamp((T - (K.AI + 11.1)) / 0.4, 0, 1), clamp((K.Report + 4.1 - T) / 0.35, 0, 1)) : 0;
    // poll pulses during Progress
    const pulses: { p: number; rev: boolean }[] = [];
    if (T >= K.Progress + 0.6 && T <= K.Progress + 6.6) {
        const cyc = 2.2;
        const local = (T - (K.Progress + 0.6)) % cyc;
        if (local < 0.9) pulses.push({ p: local / 0.9, rev: false });
        else if (local > 1.2 && local < 2.1) pulses.push({ p: (local - 1.2) / 0.9, rev: true });
    }
    const pollPct = 40 + Math.floor(clamp((T - K.Progress) / 7, 0, 1) * 45);
    return (
        <>
            <Chip x={dp[0]} y={dp[1]} opacity={dumpOp} scale={T > K.Debugging + 2 ? 0.85 : 1} icon="file" label="MEMORY.DMP" />
            <Chip x={rp[0]} y={rp[1]} opacity={rawOp} scale={0.95} dark icon="fileLines" label="raw analysis" />
            <Chip x={pp[0]} y={pp[1]} opacity={repOp} icon="fileCheck" label="your report" />
            {pulses.map((pu, i) => {
                const a = pu.rev ? A_SRV_L : A_PC;
                const b = pu.rev ? A_PC : A_SRV_L;
                const e = Easing.easeInOutSine(pu.p);
                return (
                    <div
                        key={i}
                        style={{
                            position: 'absolute',
                            left: a[0] + (b[0] - a[0]) * e,
                            top: a[1] + (b[1] - a[1]) * e - 5 + (pu.rev ? 18 : -18),
                            width: 14,
                            height: 14,
                            borderRadius: 999,
                            background: pu.rev ? C.navy : C.blue,
                            opacity: 0.9,
                        }}
                    />
                );
            })}
            {T >= K.Progress + 0.4 && T <= K.Progress + 6.8 ? (
                <div
                    style={{
                        position: 'absolute',
                        left: 690,
                        top: 300,
                        transform: 'translateX(-50%)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                        background: '#fff',
                        borderRadius: 8,
                        boxShadow: MENU_SHADOW,
                        padding: '16px 26px',
                        opacity: Math.min(clamp((T - (K.Progress + 0.4)) / 0.5, 0, 1), clamp((K.Progress + 6.8 - T) / 0.5, 0, 1)),
                    }}
                >
                    <FlowIcon name="rotate" size={24} color={C.blue} style={{ transform: `rotate(${(T * 160) % 360}deg)` }} />
                    <span style={{ font: `700 26px ${FONT}`, color: C.ink }}>Checking every 10 seconds — analyzing… {pollPct}%</span>
                </div>
            ) : null}
        </>
    );
};

const RecapLayer: React.FC<{ T: number; K: Cues }> = ({ T, K }) => {
    const R = K.Recap;
    const badges = [
        { n: 1, label: 'Upload', x: 1420, y: 660, t: R + 0.4 },
        { n: 2, label: 'Debug', x: 2345, y: 580, t: R + 0.9 },
        { n: 3, label: 'Interpret', x: 2250, y: 1060, t: R + 1.4 },
        { n: 4, label: 'Report back', x: 1420, y: 810, t: R + 1.9 },
    ];
    if (T < R + 0.2) return null;
    return (
        <>
            {badges.map((b) => (
                <div
                    key={b.n}
                    style={{
                        position: 'absolute',
                        left: b.x,
                        top: b.y,
                        transform: 'translate(-50%,-50%)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        ...MOTION.pop(T, b.t),
                    }}
                >
                    <div
                        style={{
                            width: 52,
                            height: 52,
                            borderRadius: 999,
                            background: C.blue,
                            color: '#fff',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            font: `700 27px ${FONT}`,
                            boxShadow: MENU_SHADOW,
                        }}
                    >
                        {b.n}
                    </div>
                    <div style={{ background: '#fff', borderRadius: 999, padding: '8px 18px', boxShadow: SHADOW, font: `700 22px ${FONT}`, color: C.ink }}>
                        {b.label}
                    </div>
                </div>
            ))}
            <div style={{ position: 'absolute', left: 1930, top: 130, transform: 'translateX(-50%)', ...MOTION.pop(T, R + 2.4) }}>
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 18,
                        background: C.blue,
                        borderRadius: 8,
                        boxShadow: MENU_SHADOW,
                        padding: '18px 34px',
                        whiteSpace: 'nowrap',
                    }}
                >
                    <img src="/flow/windowsforum.svg" alt="" style={{ height: 32 }} />
                    <span
                        style={{
                            font: `400 28px ${FONT}`,
                            color: 'rgba(255,255,255,0.85)',
                            borderLeft: '1px solid rgba(255,255,255,0.4)',
                            paddingLeft: 18,
                        }}
                    >
                        bsod.windowsforum.com — from crash to answer in minutes
                    </span>
                </div>
            </div>
        </>
    );
};

/** Narration, keyed to the cue table. Doubles as the accessible transcript. */
export function captionItems(K: Cues): CaptionItem[] {
    return [
        { at: 0.8, text: 'When Windows crashes, it saves a snapshot of that exact moment — a crash dump file.' },
        { at: K.Upload + 0.6, text: 'You upload that file at bsod.windowsforum.com — no account needed.' },
        { at: K.Upload + 5.5, text: 'That’s all you have to do. The pipeline takes it from here.' },
        { at: K.Handoff + 0.5, text: 'Your browser hands the file to the WindowsForum analysis server over a secure connection.' },
        { at: K.Handoff + 7.2, text: 'The server passes it to a dedicated Windows machine running a real crash debugger.' },
        { at: K.Debugging + 3.2, text: 'The dump waits its turn in a short queue…' },
        { at: K.Debugging + 7.5, text: '…then the debugger opens it, pulling Microsoft’s official reference data to decode what it sees.' },
        { at: K.Debugging + 12.5, text: 'It reconstructs the crash and names the component that most likely caused it.' },
        { at: K.Progress + 0.5, text: 'Meanwhile your browser checks in every ten seconds. Most dumps finish within a few minutes.' },
        { at: K.AI + 0.5, text: 'The debugger’s output is accurate but dense — so it goes to an AI interpreter.' },
        { at: K.AI + 5.5, text: 'The AI turns the raw output into a plain-English report anyone can act on.' },
        { at: K.Report + 0.5, text: 'The finished report travels back to your browser.' },
        { at: K.Report + 4.5, text: 'What crashed, why, and what to do next.' },
        { at: K.Recap + 0.5, text: 'Upload, debug, interpret, report — that’s bsod.windowsforum.com.' },
    ];
}

/** The whole animation: one component, rendered as a function of authored time. */
const BsodFlowPiece: React.FC<{ showCaptions?: boolean }> = ({ showCaptions = true }) => {
    const { T, CUES } = useComposition();
    const K = CUES as unknown as Cues;
    const cam = camAt(T, [
        [0, 680, 730, 2.0],
        [K.Crash + 5.5, 680, 730, 2.0],
        [K.Upload + 0.5, 680, 745, 1.55],
        [K.Upload + 9, 680, 745, 1.5],
        [K.Handoff + 2, 1180, 745, 0.82],
        [K.Handoff + 8, 1240, 745, 0.82],
        [K.Debugging + 3, 2990, 610, 1.35],
        [K.Debugging + 5.5, 2830, 480, 1.8],
        [K.Debugging + 8.5, 2960, 760, 1.55],
        [K.Debugging + 15, 2960, 700, 1.45],
        [K.Progress + 2, 1350, 780, 0.68],
        [K.Progress + 6.5, 1400, 790, 0.66],
        [K.AI + 3, 2930, 1345, 1.5],
        [K.AI + 10.5, 2930, 1355, 1.4],
        [K.Report + 2, 1900, 1000, 0.62],
        [K.Report + 5, 680, 730, 1.7],
        [K.Report + 8.5, 680, 730, 1.78],
        [K.Recap + 2.5, 1930, 880, 0.5],
        [K.Recap + 5, 1930, 880, 0.515],
    ]);
    return (
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', fontFamily: FONT, background: '#eff5f6' }}>
            <img
                src="/flow/bg-24H4_50.webp"
                alt=""
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
            />
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(239,245,246,0.42)' }} />
            <div
                style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: WORLD.w,
                    height: WORLD.h,
                    transformOrigin: '0 0',
                    transform: `translate(${FRAME.w / 2 - cam.cx * cam.s}px, ${FRAME.h / 2 - cam.cy * cam.s}px) scale(${cam.s})`,
                }}
            >
                <Wires T={T} K={K} />
                <ServerNode T={T} K={K} />
                <WindbgNode T={T} K={K} />
                <AiNode T={T} K={K} />
                <PcNode T={T} K={K} />
                <Packets T={T} K={K} />
                <RecapLayer T={T} K={K} />
            </div>
            {showCaptions ? (
                <Captions
                    items={captionItems(K)}
                    style={{
                        left: '50%',
                        right: 'auto',
                        bottom: '5.5%',
                        transform: 'translateX(-50%)',
                        maxWidth: '72%',
                        font: `600 31px ${FONT}`,
                        color: C.ink,
                        background: 'rgba(255,255,255,0.93)',
                        padding: '15px 28px',
                        borderRadius: 8,
                        boxShadow: MENU_SHADOW,
                    }}
                />
            ) : null}
        </div>
    );
};

export default BsodFlowPiece;
