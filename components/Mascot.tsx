import React from 'react';
import { ACTS, FACES, type ActId, type FaceName } from '../utils/mascotActs';

// An original blue-screen gremlin: the mascot of the progress card and of the BSOD AI chat.
// His face is one of a range of expressions (FACES); during a scan he does an act (ACTS: props
// and a face of its own, styled by the .a-* rules in styles.css); the chat gives him a pose per
// `state` (think, talk, rest, shrug, happy). The act and face markup is static, authored in
// utils/mascotActs.ts, never user or AI text.
const STATE_FACE: Record<string, FaceName> = { happy: 'content', talk: 'cheerful', think: 'curious', rest: 'sleepy', shrug: 'puzzled' };

const BASE_BOX = '-14 -22 168 176';
const ACT_BOX = '-50 -44 250 210';

const Html: React.FC<{ html: string }> = ({ html }) => <g dangerouslySetInnerHTML={{ __html: html }} />;

const Mascot: React.FC<{ state?: string; face?: FaceName; act?: ActId }> = ({ state, face, act }) => {
    const def = act ? ACTS[act] : undefined;
    const looks = def ? def.face : FACES[face ?? (state ? STATE_FACE[state] : undefined) ?? 'neutral'];
    return (
        <svg className={def ? `gr m ${def.cls}` : 'gr'} viewBox={def ? ACT_BOX : BASE_BOX} data-gs={state} aria-hidden="true">
            {def && <ellipse cx="70" cy="127" rx="52" ry="5" fill="#000" opacity=".35" />}
            {def && <Html html={def.back} />}
            <rect className="gr-limb gr-al" x="2" y="68" width="20" height="10" rx="5" />
            <rect className="gr-limb gr-ar" x="118" y="68" width="20" height="10" rx="5" />
            <rect className="gr-limb gr-fl" x="42" y="108" width="22" height="14" rx="7" />
            <rect className="gr-limb gr-fr" x="76" y="108" width="22" height="14" rx="7" />
            <g className="gr-top">
                <line className="gr-stem" x1="70" y1="26" x2="70" y2="12" />
                <circle className="gr-bulb" cx="70" cy="9" r="5.5" />
                <circle className="gr-prop gr-gear" cx="108" cy="12" r="7.5" />
                <path className="gr-ear" d="M26 38 L10 16 L40 28Z" />
                <path className="gr-ear" d="M114 38 L130 16 L100 28Z" />
                <rect className="gr-head" x="16" y="24" width="108" height="88" rx="26" />
                <rect className="gr-screen" x="27" y="35" width="86" height="64" rx="16" />
                <Html html={looks} />
            </g>
            {[[98, 20], [108, 10], [118, 0]].map(([x, y], n) => <text key={n} className={`gr-prop gr-z gr-z${n + 1}`} x={x} y={y}>z</text>)}
            <text className="gr-prop gr-q" x="6" y="12">?</text>
            {def && <Html html={def.front} />}
        </svg>
    );
};

export default React.memo(Mascot);
