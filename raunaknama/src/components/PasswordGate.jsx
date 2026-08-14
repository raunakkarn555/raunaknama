import React, { useEffect, useState } from 'react';
import './PasswordGate.css';

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
      }
    } catch {
      setError('Could not reach the server. Try again.');
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
      <form className="gate-card" onSubmit={handleSubmit}>
        <span className="gate-icon" aria-hidden="true">🔒</span>
        <h1 className="gate-title">Raunaknama</h1>
        <p className="gate-sub">Enter the password to tune in.</p>

        <input
          type="password"
          className="gate-input"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="current-password"
        />

        {error && <p className="gate-error">{error}</p>}

        <button type="submit" className="gate-submit" disabled={submitting}>
          {submitting ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}
