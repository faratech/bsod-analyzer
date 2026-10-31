import React from 'react';

// Renders the small markdown subset BSOD AI answers may use (the server keeps
// only this: server/bsodAi.js scrubAnswer): **bold**, `code` and "- " bullets.
// It builds React elements, never HTML, so nothing in an answer can become a
// link, image or script. A marker that has no partner yet (the answer is still
// streaming in) is dropped and shows as plain text until its partner arrives.
const INLINE = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`/g;

function inline(line: string): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    const plain = (text: string) => { const clean = text.replace(/\*\*|`/g, ''); if (clean) nodes.push(clean); };
    let last = 0;
    for (const match of line.matchAll(INLINE)) {
        plain(line.slice(last, match.index));
        nodes.push(match[1] !== undefined ? <strong key={nodes.length}>{match[1]}</strong> : <code key={nodes.length}>{match[2]}</code>);
        last = match.index! + match[0].length;
    }
    plain(line.slice(last));
    return nodes;
}

const ChatMarkdown: React.FC<{ text: string }> = ({ text }) => {
    const blocks: React.ReactNode[] = [];
    let items: string[] = [];
    const flush = () => {
        if (!items.length) return;
        blocks.push(<ul key={blocks.length}>{items.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>);
        items = [];
    };
    for (const line of text.split('\n')) {
        const bullet = /^\s*-\s+(.*)$/.exec(line);
        if (bullet) { items.push(bullet[1]); continue; }
        flush();
        if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    }
    flush();
    return <>{blocks}</>;
};

export default ChatMarkdown;
