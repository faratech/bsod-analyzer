import React from 'react';

// An original blue-screen gremlin: the mascot of the progress card and of the
// BSOD AI chat. styles.css gives every stage (AnalysisProgress) and every `state`
// (the chat: think, talk, rest, shrug, sweat) its own pose.
const Mascot: React.FC<{ state?: string }> = ({ state }) => (
    <svg className="gr" viewBox="-14 -22 168 176" data-gs={state} aria-hidden="true">
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
            <g className="gr-eyes"><circle className="gr-eye" cx="53" cy="62" r="7.5" /><circle className="gr-eye" cx="87" cy="62" r="7.5" /></g>
            <path className="gr-mouth" d="M57 86 Q70 75 83 86" />
            <ellipse className="gr-yawn" cx="70" cy="85" rx="8" ry="9" />
            <path className="gr-prop gr-sweat" d="M112 40 q-6 9 0 12 q6 -3 0 -12z" />
        </g>
        <g className="gr-prop gr-mag"><circle cx="118" cy="86" r="9" /><line x1="124.5" y1="92.5" x2="133" y2="101" /></g>
        <rect className="gr-prop gr-crate" x="-12" y="62" width="14" height="14" rx="3" />
        <rect className="gr-prop gr-blk" x="36" y="-2" width="14" height="14" rx="3" />
        <rect className="gr-prop gr-blk gr-blk2" x="92" y="-2" width="14" height="14" rx="3" />
        {[1, 2, 3].map(n => <rect key={n} className={`gr-prop gr-jug gr-jug${n}`} x="63" y="-12" width="10" height="10" rx="2" />)}
        {[[98, 20], [108, 10], [118, 0]].map(([x, y], n) => <text key={n} className={`gr-prop gr-z gr-z${n + 1}`} x={x} y={y}>z</text>)}
        <text className="gr-prop gr-q" x="6" y="12">?</text>
        <text className="gr-prop gr-bang" x="8" y="12">!</text>
        <text className="gr-prop gr-note" x="112" y="6">♪</text>
        </svg>
);

export default React.memo(Mascot);
