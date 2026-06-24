// WindowsForum single sign-on client.
//
// windowsforum.com (the forum) and bsod.windowsforum.com (this app) are
// same-site (shared registrable domain), so a credentialed fetch from this app
// to the forum carries the forum's session cookie. The forum's /sso/whoami
// endpoint reads the signed-in visitor and returns a short-lived HMAC-signed
// identity token; we hand that token to our own backend (/api/auth/wf/exchange)
// which verifies it and mints a tiered BSOD session. The browser never asserts
// identity itself — it only relays the signed token.

import type { Tier } from './tierState';

export interface WfUser {
  userId: number;
  username: string;
  avatar: string;
  tier: Tier;
  isPremium: boolean;
}

export const FORUM_ORIGIN = 'https://windowsforum.com';
export const APP_ORIGIN = 'https://bsod.windowsforum.com';
// XenForo account upgrade #2 = "Premium Supporter" ($20/yr → user group 312).
export const PREMIUM_UPGRADE_URL = `${FORUM_ORIGIN}/account/upgrade-purchase?user_upgrade_id=2`;
// Where the redirect-fallback lands back on this app.
const CALLBACK_PATH = '/analyzer';
const AUTO_SIGN_IN_SUPPRESSED_KEY = 'wf_sso_auto_sign_in_suppressed';

interface WhoamiResponse {
  logged_in: boolean;
  token?: string;
  user?: unknown;
}

/** Ask our own backend whether the current BSOD session already carries forum identity. */
export async function fetchSessionIdentity(): Promise<{ tier: Tier; user: WfUser | null } | null> {
  try {
    const res = await fetch('/api/auth/session', { method: 'GET', credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.success) return null;
    return { tier: (data.tier as Tier) || 'anon', user: (data.user as WfUser) ?? null };
  } catch {
    return null;
  }
}

/** Silent same-site identity check against the forum. Returns a signed token if logged in. */
export async function silentWhoami(): Promise<WhoamiResponse | null> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 3500);
  try {
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const res = await fetch(`${FORUM_ORIGIN}/sso/whoami?_wfSso=${encodeURIComponent(nonce)}`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as WhoamiResponse;
  } catch {
    // Timeout/network/CORS error — unknown forum state. Callers may keep an
    // existing BSOD session as a temporary fallback.
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

/** Drop any forum-derived identity from the current BSOD session. */
export async function clearForumIdentity(): Promise<void> {
  try {
    await fetch('/api/auth/wf/clear', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
    });
  } catch {
  }
}

export function isForumAutoSignInSuppressed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(AUTO_SIGN_IN_SUPPRESSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function suppressForumAutoSignIn(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AUTO_SIGN_IN_SUPPRESSED_KEY, '1');
  } catch {
  }
}

export function allowForumAutoSignIn(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(AUTO_SIGN_IN_SUPPRESSED_KEY);
  } catch {
  }
}

/** Exchange a forum SSO token for a tiered BSOD session (sets HttpOnly session cookies). */
export async function exchangeToken(token: string): Promise<WfUser | null> {
  try {
    const res = await fetch('/api/auth/wf/exchange', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.success ? (data.user as WfUser) : null;
  } catch {
    return null;
  }
}

/**
 * Redirect-fallback: read a token from the URL fragment (#wf_sso=… / #wf_sso_anon=1)
 * set by the forum's redirect mode, then strip it from the address bar. Fragments
 * are never sent to a server or in Referer, so the token stays private.
 */
export function consumeCallbackToken(): { token?: string; anon?: boolean } | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash || '';
  if (!hash.includes('wf_sso')) return null;

  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('wf_sso') || undefined;
  const anon = params.get('wf_sso_anon') === '1';

  // Remove the fragment so it doesn't linger in history / the address bar.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);

  if (token) {
    allowForumAutoSignIn();
    return { token };
  }
  if (anon) return { anon: true };
  return null;
}

/**
 * Sign-in fallback: top-level navigation to the forum login, which bounces back
 * through the forum's own /sso/whoami (the only host XenForo's redirect honors)
 * and on to this app's callback with a token.
 */
export function signInRedirect(): void {
  allowForumAutoSignIn();
  const callback = `${APP_ORIGIN}${CALLBACK_PATH}`;
  window.location.href = `${FORUM_ORIGIN}/sso/whoami?login=1&redirect=${encodeURIComponent(callback)}`;
}

/** Go to the forum's Premium Supporter upgrade purchase page (XenForo handles checkout). */
export function goToPremiumUpgrade(): void {
  window.location.href = PREMIUM_UPGRADE_URL;
}
