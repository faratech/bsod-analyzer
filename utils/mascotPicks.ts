import type { ActId } from './mascotActs';

// Which act he does while a stage runs. One is picked per scan from the stage's pool and never
// repeats the previous scan's act (when the pool has a choice). A stage that runs twice as long
// as usual brings the nap.
export type ScanStage = 'uploading' | 'queued' | 'processing' | 'downloading' | 'analyzing';

export const ACT_POOLS: Record<ScanStage, readonly ActId[]> = {
    uploading: ['plane', 'dance'],
    queued: ['coffee', 'read', 'dance'],
    processing: ['type', 'stack'],
    downloading: ['fish'],
    analyzing: ['juggle', 'type'],
};

export const LONG_WAIT_ACT: ActId = 'nap';

// `last` is the act this stage had in the previous scan; `random` is injectable for tests.
export function pickAct(stage: ScanStage, last?: ActId, random: () => number = Math.random): ActId {
    const pool = ACT_POOLS[stage];
    const choices = pool.length > 1 ? pool.filter(id => id !== last) : pool;
    return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
}

const lastScan: Partial<Record<ScanStage, ActId>> = {};

// The pick for a stage of the scan that is starting, remembered for the next scan.
export function chooseAct(stage: ScanStage): ActId {
    const id = pickAct(stage, lastScan[stage]);
    lastScan[stage] = id;
    return id;
}
