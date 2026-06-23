// Tiny module-level mirror of the signed-in user's tier, so non-React modules
// (e.g. the analysis orchestrator in geminiProxy.ts) can branch on premium
// status without prop-drilling. The authoritative gate is always server-side;
// this is only a client-side optimization/UX hint. AuthProvider keeps it in
// sync via setClientTier().

export type Tier = 'anon' | 'forum' | 'premium';

let currentTier: Tier = 'anon';

export function setClientTier(tier: Tier): void {
  currentTier = tier;
}

export function getClientTier(): Tier {
  return currentTier;
}

export function isPremiumTier(): boolean {
  return currentTier === 'premium';
}
