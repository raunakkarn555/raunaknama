import React, { useCallback, useEffect, useState } from 'react';
import Player from './components/Player';
import './App.css';

const TOTAL_BG_PHOTOS = 40;
const TOTAL_BG_PHOTOS_MOBILE = 44;
// Keep in sync with the `max-width: 640px` breakpoint in App.css.
const MOBILE_BREAKPOINT_QUERY = '(max-width: 640px)';

// Rotating footer taglines — fades/sweeps in on a fixed interval.
const FOOTER_TAGLINES = [
  "Some songs don't play. They understand.",
  'Pause the world. Press play.',
  'Where every feeling finds its sound.',
  'Let the music say what words cannot.',
  'A little peace, one song away.',
  'Some moments deserve a soundtrack.',
  'Close your eyes. Let the world fade.',
  "Music for the places words can't reach.",
  'Find yourself between the melodies.',
  "Not every silence needs to be filled. Some need music.",
  'One song can change the way a moment feels.',
  'Breathe in peace. Breathe out the noise.',
  'Your escape is just one song away.',
  'For the nights you feel everything.',
  'Let the rhythm slow down your thoughts.',
  "Somewhere between chaos and calm, there's music.",
  "Memories fade. The feeling of a song doesn't.",
  'Turn down the noise. Turn up your soul.',
  'Every mood has a melody waiting for you.',
  'Stay a little longer. The next song might be the one.',
  'Lost in sound. Found in peace.',
  'Let your heart choose the next song.',
  'Because some feelings deserve to be heard.',
  "The world can wait. This song can't.",
  'A melody for every version of you.',
  'Your story sounds different today.',
  'Peace begins where the noise ends.',
  'Sometimes, all you need is the right song.',
];

// How long each footer tagline stays on screen before fading to the next
// one — randomized a little each cycle within this range so the rotation
// doesn't feel mechanically fixed.
const FOOTER_TAGLINE_INTERVAL_MIN_MS = 20000;
const FOOTER_TAGLINE_INTERVAL_MAX_MS = 25000;
// How long the fade-out/fade-in transition itself takes (kept in sync with
// the CSS transition duration on .foot-tagline-text).
const FOOTER_TAGLINE_FADE_MS = 600;

const nextTaglineDelay = () =>
  FOOTER_TAGLINE_INTERVAL_MIN_MS +
  Math.random() * (FOOTER_TAGLINE_INTERVAL_MAX_MS - FOOTER_TAGLINE_INTERVAL_MIN_MS);

// Rotating, fading footer tagline — cycles through FOOTER_TAGLINES on a
// randomized 20–25s interval, purely fading (no directional motion) between
// lines.
function FooterTagline() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    let swapId;
    let revealId;

    const scheduleSwap = () => {
      swapId = setTimeout(() => {
        setVisible(false);
        revealId = setTimeout(() => {
          setIndex((prev) => (prev + 1) % FOOTER_TAGLINES.length);
          setVisible(true);
          scheduleSwap();
        }, FOOTER_TAGLINE_FADE_MS);
      }, nextTaglineDelay());
    };

    scheduleSwap();
    return () => {
      clearTimeout(swapId);
      clearTimeout(revealId);
    };
  }, []);

  return (
    <span className="foot-tagline">
      <span aria-hidden="true">🎧</span>
      <span
        key={index}
        className={`foot-tagline-text${visible ? ' foot-tagline-text--visible' : ''}`}
      >
        {FOOTER_TAGLINES[index]}
      </span>
    </span>
  );
}

// Simple expand / compress glyphs for the fullscreen toggle button.
const FullscreenIcon = ({ active }) =>
  active ? (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <path
        d="M9 4v3a2 2 0 0 1-2 2H4M15 4v3a2 2 0 0 0 2 2h3M9 20v-3a2 2 0 0 0-2-2H4M15 20v-3a2 2 0 0 1 2-2h3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <path
        d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );

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

  // ---------- Fullscreen toggle ----------
  const [isFullscreen, setIsFullscreen] = useState(
    () => typeof document !== 'undefined' && !!document.fullscreenElement
  );

  const toggleFullscreen = useCallback(() => {
    const el = document.documentElement;
    const isCurrentlyFullscreen =
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement;

    if (!isCurrentlyFullscreen) {
      const request =
        el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
      if (request) request.call(el);
    } else {
      const exit =
        document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (exit) exit.call(document);
    }
  }, []);

  // Keep isFullscreen in sync with the browser's actual fullscreen state
  // (covers the button, the F key below, and the browser's own Esc/F11 exit).
  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(
        !!(
          document.fullscreenElement ||
          document.webkitFullscreenElement ||
          document.msFullscreenElement
        )
      );
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('MSFullscreenChange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
      document.removeEventListener('MSFullscreenChange', onFullscreenChange);
    };
  }, []);

  // "F" toggles fullscreen from anywhere, as long as the person isn't
  // typing in a text field.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'f' && e.key !== 'F') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) {
        return;
      }
      toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleFullscreen]);

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
            className="hamburger-btn fullscreen-btn"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
            title={isFullscreen ? 'Exit full screen (F)' : 'Enter full screen (F)'}
          >
            <FullscreenIcon active={isFullscreen} />
          </button>
        </div>
      </header>

      <main className="stage">
        <Player onTrackChange={advanceBackground} menuOpen={menuOpen} onCloseMenu={closeMenu} />
      </main>

      <div className="site-footer">
        <footer className="foot">
          <FooterTagline />
        </footer>

        <div className="foot-copyright">
          <span className="foot-credit">
            Crafted with <span className="foot-heart" aria-hidden="true">❤️</span> by{' '}
            <span className="foot-credit-name">Raunak</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export default App;
