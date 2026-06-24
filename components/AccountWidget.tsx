import React from 'react';
import { useAuth } from '../hooks/useAuth';
import { SSO_PREVIEW, SSO_SIGNIN_PREVIEW } from '../services/featureFlags';

/**
 * Account control for the navigation bar. Wrapped in <ClientOnly> by the caller
 * so it is absent from the prerendered HTML and the first client render (keeping
 * hydration exact), then revealed post-mount once SSO has resolved.
 */
const AccountWidget: React.FC<{ mobile?: boolean }> = ({ mobile = false }) => {
  const { status, loggedIn, user, signIn } = useAuth();

  // While SSO resolves, render nothing (brief; avoids a sign-in→signed-in flicker).
  if (status === 'loading') return null;

  const wrapStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    ...(mobile ? { padding: '0.75rem 0', justifyContent: 'center', flexWrap: 'wrap' } : {}),
  };

  if (!loggedIn) {
    // Gated preview: show nothing to anyone who isn't a recognized (allow-listed)
    // user, so the public sees no sign of the feature — UNLESS a tester opted in
    // with ?signin=1 to exercise the login redirect.
    if (SSO_PREVIEW && !SSO_SIGNIN_PREVIEW) return null;
    return (
      <div className="account-widget" style={wrapStyle}>
        <button type="button" className="btn btn-primary" onClick={signIn} style={{ padding: '0.4rem 0.9rem', fontSize: '0.85rem' }}>
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div className="account-widget" style={wrapStyle} title={user?.username}>
      {user?.avatar ? (
        <img
          src={user.avatar}
          alt=""
          width={26}
          height={26}
          style={{ borderRadius: '50%', display: 'block' }}
          referrerPolicy="no-referrer"
        />
      ) : null}
      <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {user?.username}
      </span>
    </div>
  );
};

export default AccountWidget;
