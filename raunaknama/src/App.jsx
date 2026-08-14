import React, { useCallback, useEffect, useState } from 'react';
import Player from './components/Player';
import './App.css';

const TOTAL_BG_PHOTOS = 40;
const TOTAL_BG_PHOTOS_MOBILE = 44;
// Keep in sync with the `max-width: 640px` breakpoint in App.css.
const MOBILE_BREAKPOINT_QUERY = '(max-width: 640px)';

const HamburgerIcon = ({ open }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
    <path
      d="M4 6h16"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      style={{
        transformOrigin: '12px 6px',
        transition: 'transform 0.25s ease, opacity 0.2s ease',
        transform: open ? 'translateY(6px) rotate(45deg)' : 'none',
      }}
    />
    <path
      d="M4 12h16"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      style={{ transition: 'opacity 0.2s ease', opacity: open ? 0 : 1 }}
    />
    <path
      d="M4 18h16"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      style={{
        transformOrigin: '12px 18px',
        transition: 'transform 0.25s ease, opacity 0.2s ease',
        transform: open ? 'translateY(-6px) rotate(-45deg)' : 'none',
      }}
    />
  </svg>
);

// Live clock for the nav — purely presentational, ticks every second.
function NavClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const seconds = now.toLocaleTimeString([], { second: '2-digit' }).padStart(2, '0');
  const day = now.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' });

  return (
    <div className="nav-clock" aria-label={`Current time ${time}`}>
      <span className="nav-clock-time">
        {time}
        <span className="nav-clock-seconds">:{seconds}</span>
      </span>
      <span className="nav-clock-date">{day}</span>
    </div>
  );
}

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [bgIndex, setBgIndex] = useState(1);

  // Tracks whether we're on a mobile-sized viewport so the backdrop can
  // switch to the photo set saved in assets/mobile. Desktop/tablet/laptop
  // keep using the original /bg photos untouched.
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const totalBgPhotos = isMobile ? TOTAL_BG_PHOTOS_MOBILE : TOTAL_BG_PHOTOS;

  // If the viewport crosses the mobile breakpoint (resize, rotate, devtools
  // toggle), keep bgIndex valid for whichever photo set is now active
  // instead of pointing past the end of a shorter set.
  useEffect(() => {
    setBgIndex((prev) => ((prev - 1) % totalBgPhotos) + 1);
  }, [totalBgPhotos]);

  // Called by Player whenever the currently-playing track changes (new
  // song, next, previous, autoplay chain, etc.) — purely additive, doesn't
  // touch any of Player's own playback logic.
  const advanceBackground = useCallback(() => {
    setBgIndex((prev) => (prev % totalBgPhotos) + 1);
  }, [totalBgPhotos]);

  const [supportOpen, setSupportOpen] = useState(false);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Close the support-developer card with Escape, from anywhere on the page.
  useEffect(() => {
    if (!supportOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setSupportOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [supportOpen]);

  // Close the drawer with Escape, from anywhere on the page.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="App shell">
      {/* Full-bleed photo backdrop — swaps to a new frame from /bg on every
          track change, crossfading via the key-based remount below. */}
      <div className="photo-bg" aria-hidden="true">
        <div
          key={bgIndex}
          className="photo-bg-frame"
          style={{
            backgroundImage: isMobile
              ? `url(/bg/mobile/${bgIndex}.jpg)`
              : `url(/bg/${bgIndex}.jpg)`,
          }}
        />
        <span className="photo-bg-scrim" />
        <span className="photo-bg-grain" />
      </div>

      <header className="topbar">
        <div className="topbar-left">
          <button
            type="button"
            className={`hamburger-btn ${menuOpen ? 'is-open' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? 'Close menu' : 'Open playlists menu'}
            aria-expanded={menuOpen}
          >
            <HamburgerIcon open={menuOpen} />
          </button>
          <div className="topbar-mark">
            <span className="pole-chip" aria-hidden="true" />
            <span className="brand">Raunaknama</span>
          </div>
        </div>

        <div className="topbar-right">
          <NavClock />
          <div className="listener-pill">
            <span className="dot" aria-hidden="true" />
            <span>On Air</span>
          </div>
          <button
            type="button"
            className="support-dev-btn support-dev-btn--nav"
            onClick={() => setSupportOpen(true)}
            aria-label="Support the developer"
          >
            <span aria-hidden="true">☕</span>
            <span>Support Developer</span>
          </button>
        </div>
      </header>

      <main className="stage">
        <Player onTrackChange={advanceBackground} menuOpen={menuOpen} onCloseMenu={closeMenu} />
      </main>

      <div className="site-footer">
        <footer className="foot">
          <span className="foot-tagline">
            <span aria-hidden="true">🎧</span> The barber shop's old-school Bollywood mixtape.
          </span>
        </footer>

        <div className="foot-copyright">
          <span className="foot-credit">
            Crafted with <span className="foot-heart" aria-hidden="true">❤️</span> by{' '}
            <span className="foot-credit-name">Raunak</span>
          </span>
        </div>
      </div>

      {supportOpen && (
        <div
          className="support-modal-overlay"
          onClick={() => setSupportOpen(false)}
        >
          <div
            className="support-modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="support-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="support-modal-close"
              onClick={() => setSupportOpen(false)}
              aria-label="Close"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
                <path d="M5 5l14 14M19 5L5 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>

            <span className="support-modal-icon" aria-hidden="true">☕</span>

            <h2 id="support-modal-title" className="support-modal-title">
              Keep the Station on Air
            </h2>

            <p className="support-modal-line">
              Every crossfade, every playlist, every late-night bug fix — running on chai and stubbornness.
            </p>
            <p className="support-modal-sub">
              If Raunaknama's been your soundtrack, a small tip helps keep it spinning.
            </p>

            <a
              href="#"
              className="support-modal-cta"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span aria-hidden="true">☕</span>
              <span>Send a Tip</span>
            </a>

            <button
              type="button"
              className="support-modal-dismiss"
              onClick={() => setSupportOpen(false)}
            >
              Maybe later
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
