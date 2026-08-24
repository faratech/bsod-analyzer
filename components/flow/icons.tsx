/**
 * Icon set for the pipeline flow.
 *
 * The source design links Font Awesome from a CDN. This site's CSP only allows
 * stylesheets from 'self' and fonts.googleapis.com, and a webfont for eighteen
 * glyphs would be a poor trade anyway — so the glyphs are inline SVG instead,
 * drawn to the WindowsForum design system's ad-hoc icon convention: 24x24
 * viewBox, stroke-based, stroke-width 2, round caps and joins, currentColor.
 */
import React from 'react';

export type FlowIconName =
    | 'server'
    | 'microchip'
    | 'sparkles'
    | 'shield'
    | 'route'
    | 'send'
    | 'checkCircle'
    | 'check'
    | 'file'
    | 'fileLines'
    | 'fileCheck'
    | 'fileShield'
    | 'cloudUpload'
    | 'lock'
    | 'database'
    | 'terminal'
    | 'rotate'
    | 'wrench';

const FILE_OUTLINE = 'M13.5 2.5H7A2.5 2.5 0 0 0 4.5 5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8.5z';
const FILE_FOLD = 'M13.5 2.5v6h6';

const PATHS: Record<FlowIconName, string[]> = {
    server: [
        'M5.5 4h13A2.5 2.5 0 0 1 21 6.5v2A2.5 2.5 0 0 1 18.5 11h-13A2.5 2.5 0 0 1 3 8.5v-2A2.5 2.5 0 0 1 5.5 4z',
        'M5.5 13h13a2.5 2.5 0 0 1 2.5 2.5v2a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-2A2.5 2.5 0 0 1 5.5 13z',
        'M7 7.5h.01',
        'M7 16.5h.01',
    ],
    microchip: [
        'M8.5 7h7A1.5 1.5 0 0 1 17 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 15.5v-7A1.5 1.5 0 0 1 8.5 7z',
        'M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
    ],
    sparkles: ['M3 21 15 9', 'M18 2.5l1.3 3.2L22.5 7l-3.2 1.3L18 11.5l-1.3-3.2L13.5 7l3.2-1.3z', 'M7 2l.7 1.8L9.5 4.5 7.7 5.2 7 7l-.7-1.8L4.5 4.5l1.8-.7z'],
    shield: ['M12 2.5 20 5.5v6c0 4.6-3.3 8.2-8 9.9-4.7-1.7-8-5.3-8-9.9v-6z', 'M12 2.5v18.9'],
    route: ['M4 18h9a4 4 0 0 0 4-4V7', 'm13.5 10.5 3.5-3.5 3.5 3.5'],
    send: ['M21.5 2.5 2.5 9.5l7.5 3 3 7.5z', 'M21.5 2.5 10 12.5'],
    checkCircle: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z', 'm8 12.5 2.8 2.8 5.7-5.8'],
    check: ['M4.5 12.5 9.5 17.5 19.5 6.5'],
    file: [FILE_OUTLINE, FILE_FOLD],
    fileLines: [FILE_OUTLINE, FILE_FOLD, 'M8.5 13h7M8.5 16.5h7M8.5 9.5h2'],
    fileCheck: [FILE_OUTLINE, FILE_FOLD, 'm9 15.2 2.2 2.3 4.3-4.5'],
    fileShield: [FILE_OUTLINE, FILE_FOLD, 'M12 11.3l3.6 1.4v2.6c0 2-1.5 3.7-3.6 4.4-2.1-.7-3.6-2.4-3.6-4.4v-2.6z'],
    cloudUpload: ['M6.8 18.5A4.3 4.3 0 0 1 7 9.9a6 6 0 0 1 11.3 1.6 3.8 3.8 0 0 1-1 7', 'M12 21.5V10.5', 'm8.5 14 3.5-3.5 3.5 3.5'],
    lock: ['M6.5 10.5h11A2.5 2.5 0 0 1 20 13v6a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 19v-6a2.5 2.5 0 0 1 2.5-2.5z', 'M8 10.5V7a4 4 0 0 1 8 0v3.5'],
    database: [
        'M12 2.5c4.1 0 7.5 1.3 7.5 3S16.1 8.5 12 8.5 4.5 7.2 4.5 5.5 7.9 2.5 12 2.5z',
        'M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13',
        'M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3',
    ],
    terminal: ['M5 4h14a2.5 2.5 0 0 1 2.5 2.5v11A2.5 2.5 0 0 1 19 20H5a2.5 2.5 0 0 1-2.5-2.5v-11A2.5 2.5 0 0 1 5 4z', 'm7 9.5 3 2.5-3 2.5', 'M13 15h4'],
    rotate: ['M20.5 12a8.5 8.5 0 1 1-2.49-6.01', 'M20.5 4v5.5H15'],
    wrench: [
        'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z',
    ],
};

interface FlowIconProps {
    name: FlowIconName;
    /** Rendered box size in px — matches the `fontSize` the glyph replaces. */
    size: number;
    color?: string;
    style?: React.CSSProperties;
}

/**
 * Decorative by construction: the whole stage is aria-hidden and described by
 * the transcript next to it, so every glyph is hidden from assistive tech.
 */
export const FlowIcon: React.FC<FlowIconProps> = ({ name, size, color, style }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color || 'currentColor'}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={{ display: 'block', flexShrink: 0, ...style }}
    >
        {PATHS[name].map((d, i) => (
            <path key={i} d={d} />
        ))}
    </svg>
);

export default FlowIcon;
