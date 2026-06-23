import React, { useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';

const BENEFITS: { icon: string; title: string; body: string }[] = [
  { icon: '⚡', title: '10× higher limits', body: '100 analyses/hour and 1M tokens/hour — vs 10/hour on the free tier.' },
  { icon: '🔬', title: 'Deep WinDBG kernel analysis', body: 'Full call stacks, IRQL, bug-check parameters and module attribution from real kernel-dump debugging.' },
  { icon: '🚫', title: 'Ad-free', body: 'No advertising anywhere in the analyzer.' },
  { icon: '🚀', title: 'Priority analysis', body: 'Your dumps go to the front of the queue.' },
  { icon: '💙', title: 'Support WindowsForum', body: 'Membership funds the forum and keeps the free tier running.' },
];

/**
 * Global premium paygate. Opened via useAuth().openPaygate() from the nav, on a
 * tier limit, or when a premium-only feature is requested. Checkout is the
 * forum's native XenForo account-upgrade flow ($20/yr → user group 312); on
 * return, membership is picked up on the next SSO refresh.
 */
const PremiumModal: React.FC = () => {
  const { paygate, closePaygate, upgrade, signIn, loggedIn, isPremium } = useAuth();
  const open = paygate.open && !isPremium;

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePaygate();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, closePaygate]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Join WindowsForum Premium"
      onClick={closePaygate}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 480,
          maxHeight: '90vh',
          overflowY: 'auto',
          background: 'var(--bg-secondary, #14141a)',
          color: 'var(--text-primary, #fff)',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: 16,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          padding: '1.75rem',
          position: 'relative',
        }}
      >
        <button
          type="button"
          aria-label="Close"
          onClick={closePaygate}
          style={{
            position: 'absolute',
            top: 12,
            right: 14,
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary, #aaa)',
            fontSize: '1.5rem',
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          ×
        </button>

        <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
          <div
            style={{
              display: 'inline-block',
              fontSize: '0.72rem',
              fontWeight: 700,
              letterSpacing: '0.05em',
              padding: '0.25rem 0.7rem',
              borderRadius: 999,
              color: '#1a1200',
              background: 'linear-gradient(135deg, #ffd34d, #ffb300)',
              marginBottom: '0.75rem',
            }}
          >
            ★ PREMIUM
          </div>
          <h2 style={{ margin: '0 0 0.35rem', fontSize: '1.5rem' }}>Unlock the full analyzer</h2>
          <p style={{ margin: 0, color: 'var(--text-secondary, #aaa)', fontSize: '0.95rem' }}>
            Included with <strong>WindowsForum Premium Supporter</strong> — $20/year.
          </p>
        </div>

        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1.5rem', display: 'grid', gap: '0.85rem' }}>
          {BENEFITS.map((b) => (
            <li key={b.title} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
              <span aria-hidden style={{ fontSize: '1.2rem', lineHeight: 1.2 }}>{b.icon}</span>
              <span>
                <strong style={{ display: 'block', fontSize: '0.95rem' }}>{b.title}</strong>
                <span style={{ color: 'var(--text-secondary, #aaa)', fontSize: '0.85rem' }}>{b.body}</span>
              </span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          className="btn btn-primary"
          onClick={upgrade}
          style={{ width: '100%', padding: '0.85rem', fontSize: '1rem', fontWeight: 600 }}
        >
          {loggedIn ? 'Join Premium — $20/year' : 'Continue to WindowsForum — $20/year'}
        </button>

        <p style={{ textAlign: 'center', margin: '0.9rem 0 0', fontSize: '0.8rem', color: 'var(--text-tertiary, #888)' }}>
          {loggedIn ? (
            'You can keep using the analyzer free meanwhile.'
          ) : (
            <>
              Already a Premium Supporter?{' '}
              <button
                type="button"
                onClick={signIn}
                style={{ background: 'none', border: 'none', color: 'var(--accent, #4da3ff)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline', padding: 0 }}
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
};

export default PremiumModal;
