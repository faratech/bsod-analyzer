// Server-to-server forum identity resolver.
//
// bsod.windowsforum.com (Cloud Run) cannot reach the forum DB/Redis and must not
// re-implement XenForo session/remember-me semantics. Instead, once the forum
// shares its xf_session/xf_user cookies to `.windowsforum.com`, bsod's backend
// receives them and forwards them — server-to-server, behind a shared secret — to
// the on-box validator (`/sso-validate.php`), which boots XenForo and lets XF
// itself resolve the visitor (Redis session + remember-me + IP-binding). The
// validator returns the authenticated identity as JSON; we never parse PHP, hold
// a DB grant, or trust a raw cookie here.
//
// Dormant until FORUM_VALIDATE_URL is set AND an xf_* cookie actually arrives, so
// shipping this changes nothing until the cookie-domain migration happens.
import { createHash } from 'node:crypto';
import { getRuntimeValue, setRuntimeValue } from './cache.js';

const ENDPOINT = process.env.FORUM_VALIDATE_URL || '';
// Reuse the existing shared secret (also mounted for the legacy token path).
const KEY = process.env.WF_SSO_SECRET || '';
const POS_TTL_SECONDS = 45;   // positive identity: forum logout/expiry surfaces within ~45s
const NEG_TTL_SECONDS = 10;   // negatives expire fast so a transient blip can't pin a user to guest
const TIMEOUT_MS = 2000;      // never let a slow forum hang a bsod auth check

// Reject any cookie/IP value that could break out of a header (defense-in-depth:
// undici already rejects these, but this keeps fail-closed independent of the
// HTTP client and avoids a wasted round-trip).
const HEADER_UNSAFE = /[\r\n\x00]/;

export function isForumIdentityEnabled() {
  return ENDPOINT !== '' && KEY !== '';
}

// Key on the cookie AND the end-user IP, so the validator's per-user /24 session
// IP-binding isn't eroded by a cached decision being reused for a different IP.
function cacheKeyFor(token, clientIp) {
  return 'xfid:' + createHash('sha256').update(String(token) + '|' + String(clientIp || '')).digest('hex').slice(0, 32);
}

/**
 * Resolve {userId, username, avatar, tier, isPremium} from the shared forum
 * cookies, or null for a guest/invalid/banned visitor. Fails CLOSED to null on any
 * error/timeout — never throws, never 500s the caller. Caches positives ~45s and
 * negatives ~10s, keyed on (cookie + ip) so it self-invalidates on cookie rotation.
 */
export async function resolveForumIdentityFromCookies(cookies, clientIp) {
  if (!isForumIdentityEnabled()) return null;
  const xfSession = cookies?.xf_session;
  const xfUser = cookies?.xf_user;
  if (!xfSession && !xfUser) return null;

  // Fail closed on any header-unsafe input rather than forwarding it.
  if (
    (xfSession && HEADER_UNSAFE.test(xfSession)) ||
    (xfUser && HEADER_UNSAFE.test(xfUser)) ||
    (clientIp && HEADER_UNSAFE.test(clientIp))
  ) {
    return null;
  }

  const cacheKey = cacheKeyFor(xfSession || xfUser, clientIp);
  try {
    const cached = await getRuntimeValue(cacheKey);
    if (cached != null) return cached.userId ? cached : null;
  } catch { /* fall through to a live lookup */ }

  let identity = null;
  try {
    const cookieHeader = [
      xfSession ? `xf_session=${xfSession}` : null,
      xfUser ? `xf_user=${xfUser}` : null,
    ].filter(Boolean).join('; ');

    const res = await fetch(ENDPOINT, {
      method: 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'X-WF-SSO-Key': KEY,
        'X-WF-Real-IP': clientIp || '',
        Cookie: cookieHeader,
        Accept: 'application/json',
      },
    });
    if (res.ok) {
      const data = await res.json();
      const uid = Number(data?.userId) || 0;
      if (uid > 0) {
        identity = {
          userId: uid,
          username: typeof data.username === 'string' ? data.username.slice(0, 80) : '',
          avatar:
            typeof data.avatar === 'string' && /^https:\/\//i.test(data.avatar)
              ? data.avatar.slice(0, 400)
              : '',
          tier: data.isPremium ? 'premium' : 'forum',
          isPremium: data.isPremium === true,
        };
      }
    }
  } catch {
    identity = null; // fail closed
  }

  try {
    await setRuntimeValue(cacheKey, identity || { userId: 0 }, identity ? POS_TTL_SECONDS : NEG_TTL_SECONDS);
  } catch { /* cache write is best-effort */ }
  return identity;
}
