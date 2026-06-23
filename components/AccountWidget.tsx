import React from 'react';
import { useAuth } from '../hooks/useAuth';

/**
 * Account control for the navigation bar. Wrapped in <ClientOnly> by the caller
 * so it is absent from the prerendered HTML and the first client render (keeping
 * hydration exact), then revealed post-mount once SSO has resolved.
 */
const AccountWidget: React.FC<{ mobile?: boolean }> = ({ mobile = false }) => {
  const { status, loggedIn, user, isPremium, signIn, openPaygate } = useAuth();

  // While SSO resolves, render nothing (brief; avoids a sign-in→signed-in flicker).
  if (status === 'loading') return null;

  const wrapStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    ...(mobile ? { padding: '0.75rem 0', justifyContent: 'center', flexWrap: 'wrap' } : {}),
  };

  if (!loggedIn) {
    return (
      <div className="account-widget" style={wrapStyle}>
        <button type="button" className="nav-link" onClick={signIn} style={{ background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }}>
          Sign in
        </button>
        <button type="button" className="btn btn-primary" onClick={() => openPaygate('nav')} style={{ padding: '0.4rem 0.9rem', fontSize: '0.85rem' }}>
          Join Now
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
      {isPremium ? (
        <span
          title="WindowsForum Premium Supporter"
          style={{
            fontSize: '0.72rem',
            fontWeight: 700,
            letterSpacing: '0.03em',
            padding: '0.18rem 0.5rem',
            borderRadius: '999px',
            color: '#1a1200',
            background: 'linear-gradient(135deg, #ffd34d, #ffb300)',
            whiteSpace: 'nowrap',
          }}
        >
          ★ PREMIUM
        </span>
      ) : (
        <button type="button" className="btn btn-primary" onClick={() => openPaygate('nav')} style={{ padding: '0.35rem 0.8rem', fontSize: '0.8rem' }}>
          Upgrade
        </button>
      )}
    </div>
  );
};

export default AccountWidget;
