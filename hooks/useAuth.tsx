import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import {
  WfUser,
  fetchSessionIdentity,
  silentWhoami,
  exchangeToken,
  consumeCallbackToken,
  signInRedirect,
} from '../services/wfAuth';
import { setClientTier, Tier } from '../services/tierState';
import { markSessionInitialized, startSessionRefresh } from '../utils/sessionManager';
import { SSO_ENABLED } from '../services/featureFlags';

type AuthStatus = 'loading' | 'ready';

// The premium tier (isPremium/quotas/ad-free) is retained; only the paywall — the
// upgrade paygate UI and its trigger API — was removed, so AuthContext no longer
// exposes upgrade()/openPaygate()/closePaygate()/paygate.
interface AuthContextType {
  status: AuthStatus;
  tier: Tier;
  user: WfUser | null;
  loggedIn: boolean;
  isPremium: boolean;
  signIn: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  // Deterministic SSR / first-paint state (anonymous, loading) so the
  // prerendered homepage hydrates byte-for-byte. Real identity is resolved in an
  // effect (client only); any account UI must therefore be ClientOnly. When the
  // feature is disabled we start 'ready'/anon and never fetch anything.
  const [status, setStatus] = useState<AuthStatus>(SSO_ENABLED ? 'loading' : 'ready');
  const [tier, setTier] = useState<Tier>('anon');
  const [user, setUser] = useState<WfUser | null>(null);

  const applyUser = useCallback((u: WfUser | null, t: Tier) => {
    setUser(u);
    setTier(t);
    setClientTier(t);
    if (u) {
      // The exchange already established a verified BSOD session (cookies set).
      markSessionInitialized();
      startSessionRefresh();
    }
  }, []);

  const resolve = useCallback(async () => {
    // 0) Redirect-fallback token in the URL fragment takes priority.
    const cb = consumeCallbackToken();
    if (cb?.token) {
      const u = await exchangeToken(cb.token);
      if (u) {
        applyUser(u, u.tier);
        setStatus('ready');
        return;
      }
    }

    // 1) Does our existing BSOD session already carry forum identity?
    const existing = await fetchSessionIdentity();
    if (existing?.user) {
      applyUser(existing.user, existing.tier);
      setStatus('ready');
      return;
    }

    // 2) Silent same-site check against the forum (skip if the fallback already
    //    told us the visitor is anonymous).
    if (!cb?.anon) {
      const who = await silentWhoami();
      if (who?.logged_in && who.token) {
        const u = await exchangeToken(who.token);
        if (u) {
          applyUser(u, u.tier);
          setStatus('ready');
          return;
        }
      }
    }

    // Anonymous.
    applyUser(null, 'anon');
    setStatus('ready');
  }, [applyUser]);

  useEffect(() => {
    if (!SSO_ENABLED) return; // dormant: no forum identity fetch
    resolve();
  }, [resolve]);

  // Status-quiet re-verification: updates tier/user without flipping back to
  // 'loading' (so the account widget doesn't flicker on background re-checks).
  const refresh = useCallback(async () => {
    const who = await silentWhoami();
    if (who?.logged_in && who.token) {
      const u = await exchangeToken(who.token);
      if (u) {
        applyUser(u, u.tier);
        return;
      }
    }
    const existing = await fetchSessionIdentity();
    if (existing?.user) {
      applyUser(existing.user, existing.tier);
    } else {
      applyUser(null, 'anon');
    }
  }, [applyUser]);

  // Silently re-verify forum membership on an interval (and when the tab regains
  // focus, throttled), below the backend's tier re-verification window, so an
  // active premium user stays elevated while a cancelled/expired membership is
  // dropped promptly.
  useEffect(() => {
    if (!SSO_ENABLED) return; // dormant: no periodic re-verification
    const REVERIFY_MS = 12 * 60 * 1000;
    const FOCUS_THROTTLE_MS = 5 * 60 * 1000;
    let lastReverify = Date.now();
    const run = () => {
      lastReverify = Date.now();
      refresh();
    };
    const id = setInterval(run, REVERIFY_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastReverify > FOCUS_THROTTLE_MS) {
        run();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const value: AuthContextType = {
    status,
    tier,
    user,
    loggedIn: !!user,
    isPremium: tier === 'premium',
    signIn: signInRedirect,
    refresh,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
};

/** Non-throwing accessor for components that may render before/without the provider. */
export const useOptionalAuth = (): AuthContextType | undefined => useContext(AuthContext);
