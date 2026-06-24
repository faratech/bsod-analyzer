// Runtime feature flags.
//
// The server injects `window.__WF_SSO_ENABLED__` / `window.__WF_SSO_PREVIEW__`
// into the served HTML from env (see server.js startup), so the bundle is
// flag-agnostic and the feature toggles with a Cloud Run env var + redeploy — no
// rebuild, no Docker build-args. Defaults are false; during SSR/prerender there is
// no `window`, so both are false and the prerendered homepage carries no SSO UI.
declare global {
  interface Window {
    __WF_SSO_ENABLED__?: boolean;
    __WF_SSO_PREVIEW__?: boolean;
  }
}

const w: Window | undefined = typeof window !== 'undefined' ? window : undefined;

// Master switch for the whole feature (forum identity fetch + UI + tiering).
export const SSO_ENABLED: boolean = w?.__WF_SSO_ENABLED__ === true;

// Gated-preview mode: only recognized (allow-listed) users see any UI. The
// anonymous "Sign in / Join Now" affordances stay hidden from the public, so a
// deployed-but-gated rollout reveals nothing to anyone who isn't allow-listed.
export const SSO_PREVIEW: boolean = w?.__WF_SSO_PREVIEW__ === true;

// Tester escape hatch: append `?signin=1` to reveal the anonymous "Sign in"
// affordances even while preview-mode is hiding them, so the full XF login
// redirect can be exercised end-to-end without un-gating it for the public.
// Persisted to sessionStorage so it survives in-app navigation during a test.
function computeSigninPreview(): boolean {
  if (!w) return false;
  try {
    if (new URLSearchParams(w.location.search).get('signin') === '1') {
      w.sessionStorage.setItem('wf_sso_signin_preview', '1');
      return true;
    }
    return w.sessionStorage.getItem('wf_sso_signin_preview') === '1';
  } catch {
    return false;
  }
}
export const SSO_SIGNIN_PREVIEW: boolean = computeSigninPreview();

export {};
