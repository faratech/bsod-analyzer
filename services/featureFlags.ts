// Build-time feature flags.
//
// __WF_SSO_ENABLED__ is injected by Vite from the WF_SSO_ENABLED env var at build
// time (default false). While false the WindowsForum SSO + premium-tier upgrade is
// completely dormant: no forum identity fetch, no account/paygate UI, and the
// backend keeps its original (pre-upgrade) rate limits and WinDBG behavior — so the
// running site is byte-for-byte unchanged. Flip WF_SSO_ENABLED=true (and rebuild)
// to launch it.
declare const __WF_SSO_ENABLED__: boolean;

export const SSO_ENABLED: boolean =
  typeof __WF_SSO_ENABLED__ !== 'undefined' ? __WF_SSO_ENABLED__ : false;
