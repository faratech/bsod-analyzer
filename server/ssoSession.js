// Which session a forum SSO exchange (/api/auth/wf/exchange) issues (issue #354).
//
// The browser re-verifies a signed-in member every 12 minutes and on tab
// focus. Minting a new session id each time broke every WinDBG file handle the
// tab held (handles are signed for the uploading session), so an analysis
// running across a re-verification lost its own upstream job.
//
// The id is kept only when the presented session is valid, verified and
// already bound, in its signed claims, to the same forum user the fresh SSO
// token proves: that re-verifies an identity, it does not elevate one. Every
// other case gets a new id as before: no or an invalid/expired cookie, an
// anonymous session (first sign-in is a privilege change, and rotating there
// is the session-fixation defense: a planted id is never upgraded), or a
// session of a different forum user.
//
// Either way the session data is rebuilt from the fresh identity (nothing is
// carried over from the old claims), with a fresh createdAt, as every exchange
// did before.

/**
 * @param {object} args
 * @param {{ valid: boolean, sessionId?: string, sessionData?: object } | null} args.presented
 *   sessionCodec.verify() of the request's session cookie, or null when none.
 * @param {{ uid: number|string, tier: string, username?: string, avatar?: string }} args.identity
 *   The verified SSO identity.
 * @param {() => { sessionId: string, sessionData: object }} args.createSession
 * @param {number} args.reverifyMs  How long the elevated tier is honoured.
 * @returns {{ sessionId: string, sessionData: object, kept: boolean }}
 */
export function exchangeSession({ presented, identity, createSession, reverifyMs, now = Date.now() }) {
  const previousUid = presented?.valid === true && presented.sessionData?.turnstileVerified === true
    ? presented.sessionData.wfUserId
    : undefined;
  const kept = previousUid !== undefined && previousUid !== null && previousUid !== ''
    && String(previousUid) === String(identity.uid);

  const { sessionId, sessionData } = kept
    ? { sessionId: presented.sessionId, sessionData: { timestamp: now, createdAt: now, turnstileVerified: true } }
    : createSession();

  sessionData.tier = identity.tier; // 'premium' | 'forum'
  sessionData.wfUserId = identity.uid;
  sessionData.wfUsername = identity.username;
  sessionData.wfAvatar = identity.avatar;
  sessionData.wfVerifiedAt = now;
  // The elevated tier is only honored until this; the client re-verifies before it.
  sessionData.tierExpiresAt = now + reverifyMs;
  return { sessionId, sessionData, kept };
}
