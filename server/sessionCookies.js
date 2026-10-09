// Which session cookies a response should delete.
//
// Every session cookie is SameSite=Lax, so a cross-site POST (an auto-submitted
// form) arrives without any of them, and a browser still applies Set-Cookie
// deletions from the response to that top-level navigation. A 401 that clears
// every cookie unconditionally therefore let any site log a visitor out of BSOD
// (issue #141). Deleting only the cookies the request actually presented keeps
// the same-site behaviour (the browser sends every cookie it holds for this
// host) and makes the cross-site case a no-op: nothing was sent, nothing is
// cleared.

export const LEGACY_SESSION_COOKIES = ['bsod_session_id', 'bsod_session_hash'];

export const ALL_SESSION_COOKIES = Object.freeze([
  ...['bsod_session', ...LEGACY_SESSION_COOKIES].map(name => Object.freeze({ name, httpOnly: true })),
  // Read by the client (utils/sessionManager.ts), so not HttpOnly.
  Object.freeze({ name: 'bsod_turnstile_verified', httpOnly: false }),
]);

// The subset of ALL_SESSION_COOKIES present in a request's parsed cookies.
// Anything that is not a cookie object counts as "nothing presented".
export function presentedSessionCookies(cookies) {
  if (!cookies || typeof cookies !== 'object') return [];
  return ALL_SESSION_COOKIES.filter(({ name }) => Object.prototype.hasOwnProperty.call(cookies, name));
}
