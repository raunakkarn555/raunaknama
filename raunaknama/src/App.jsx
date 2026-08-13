import React, { useCallback, useEffect, useState } from 'react';
import Player from './components/Player';
import './App.css';

const TOTAL_BG_PHOTOS = 9;

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

  // Called by Player whenever the currently-playing track changes (new
  // song, next, previous, autoplay chain, etc.) — purely additive, doesn't
  // touch any of Player's own playback logic.
  const advanceBackground = useCallback(() => {
    setBgIndex((prev) => (prev % TOTAL_BG_PHOTOS) + 1);
  }, []);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

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
          style={{ backgroundImage: `url(/bg/${bgIndex}.jpg)` }}
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
        </div>
      </header>

      <main className="stage">
        <Player onTrackChange={advanceBackground} menuOpen={menuOpen} onCloseMenu={closeMenu} />
      </main>

      <footer className="foot">
        <span>90s Bollywood radio, on loop.</span>
      </footer>
    </div>
  );
}

export default App;
