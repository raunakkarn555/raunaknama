import React, { useEffect, useState } from 'react';
import './PasswordGate.css';
import Icon from './Icon';

// Gates the whole app behind a password that's checked on the server
// (netlify/functions/auth.mjs) — the real password lives only in the
// server's environment variables (SITE_PASSWORD), never in this bundle.
//
// On success the server sets an HttpOnly session cookie that's valid for
// 7 days, so the same browser/device won't be asked again until it
// expires. A new device (no cookie yet) is always asked.
export default function PasswordGate({ children }) {
  // 'checking' | 'locked' | 'unlocked'
  const [status, setStatus] = useState('checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth', { method: 'GET', credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : { authenticated: false }))
      .then((data) => {
        if (cancelled) return;
        setStatus(data.authenticated ? 'unlocked' : 'locked');
      })
      .catch(() => {
        if (!cancelled) setStatus('locked');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setStatus('unlocked');
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Incorrect password. Try again.');
        setShakeKey((k) => k + 1);
      }
    } catch {
      setError('Could not reach the server. Try again.');
      setShakeKey((k) => k + 1);
    } finally {
      setSubmitting(false);
      setPassword('');
    }
  };

  if (status === 'checking') {
    return <div className="gate-checking" aria-hidden="true" />;
  }

  if (status === 'unlocked') {
    return children;
  }

  return (
    <div className="gate-overlay">
      <div className="gate-bg" aria-hidden="true" />
      <div className="gate-glow gate-glow--gold" aria-hidden="true" />
      <div className="gate-glow gate-glow--red" aria-hidden="true" />
      <div className="gate-vignette" aria-hidden="true" />

      <main className="gate-wrap">
        <form
          key={shakeKey}
          className={`gate-card${shakeKey ? ' is-shaking' : ''}`}
          onSubmit={handleSubmit}
        >
          <div className="gate-mark" aria-hidden="true">
            <span className="gate-mark-ring" />
            <span className="gate-mark-core"><Icon name="lock" size="26px" /></span>
          </div>

          <div className="gate-eq" aria-hidden="true">
            {Array.from({ length: 9 }).map((_, i) => (
              <span key={i} style={{ animationDelay: `${i * 0.12}s` }} />
            ))}
          </div>

          <span className="gate-eyebrow">Private listening room</span>
          <h1 className="gate-title">Raunaknama</h1>
          <p className="gate-sub">Enter the password to tune in.</p>

          <label className={`gate-field${error ? ' has-error' : ''}`}>
            <span className="gate-field-icon" aria-hidden="true"><Icon name="lock" size="18px" /></span>
            <input
              type={showPw ? 'text' : 'password'}
              className="gate-input"
              placeholder="Password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); if (error) setError(''); }}
              autoFocus
              autoComplete="current-password"
              aria-label="Password"
              aria-invalid={!!error}
            />
            <button
              type="button"
              className="gate-eye"
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              <Icon name={showPw ? 'eyeOff' : 'eye'} size="18px" />
            </button>
          </label>

          {error && (
            <p className="gate-error" role="alert"><Icon name="alert" size="15px" /> {error}</p>
          )}

          <button type="submit" className="gate-submit" disabled={submitting || !password}>
            {submitting ? (
              <><span className="gate-spinner" aria-hidden="true" /> Checking…</>
            ) : (
              <>Enter <Icon name="arrowRight" size="18px" /></>
            )}
          </button>

          <p className="gate-foot">Your session stays unlocked on this device for 7 days.</p>
        </form>
      </main>
    </div>
  );
}
