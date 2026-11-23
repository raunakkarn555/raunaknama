import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Player from './components/Player';
import { RecommendedGrid } from './components/Dashboard';
import GuideButton from './components/GuideButton';
import Icon from './components/Icon';
import { warmStream } from './streamClient';
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

// ---------- Dynamic color theming ----------
// Samples the dominant color out of the currently-showing backdrop photo
// (the closest thing this app has to per-track "album art" — see the
// photo-bg rotation below) via a tiny offscreen canvas, then hands it back
// as an { r, g, b } average. Local/same-origin images only, so no CORS
// headaches. Resolves to null on any failure — callers just keep whatever
// accent color (or the static gold/red default) was already showing.
const extractDominantColor = (imgSrc) =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          count += 1;
        }
        resolve({
          r: Math.round(r / count),
          g: Math.round(g / count),
          b: Math.round(b / count),
        });
      } catch (err) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = imgSrc;
  });

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
      <Icon name="headphones" />
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

// "Mode" dropdown that sits in the nav where the clock used to be.
// Default = the original Player-only home screen; Recommended = adds the
// unlimited Piped card grid under the player. The player itself never changes.
const MODE_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'recommended', label: 'Recommended' },
];

function ModeMenu({ mode, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = MODE_OPTIONS.find((m) => m.id === mode) || MODE_OPTIONS[0];

  return (
    <div className="mode-menu" ref={rootRef}>
      <button
        type="button"
        className={`mode-menu-btn ${open ? 'is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={`Mode: ${current.label}`}
      >
        <span className="mode-menu-label">Mode</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <ul className="mode-menu-list" role="listbox" aria-label="Mode">
          {MODE_OPTIONS.map((m) => (
            <li key={m.id} role="option" aria-selected={m.id === mode}>
              <button
                type="button"
                className={`mode-menu-item ${m.id === mode ? 'is-active' : ''}`}
                onClick={() => { onChange(m.id); setOpen(false); }}
              >
                {m.label}
                {m.id === mode && <Icon name="check" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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

// One backdrop photo layer. It preloads its image first and only then fades
// in, on top of the previous photo (kept underneath), so a track change is a
// real crossfade instead of a fade-from-dark.
function BgFrame({ src, incoming }) {
  const [ready, setReady] = useState(!incoming);
  useEffect(() => {
    if (!incoming) return undefined;
    let alive = true;
    const img = new Image();
    const done = () => { if (alive) setReady(true); };
    img.onload = done;
    img.onerror = done;
    img.src = src;
    if (img.complete) done();
    return () => { alive = false; };
  }, [src, incoming]);
  return (
    <div
      className={`photo-bg-frame${incoming ? ' photo-bg-frame--in' : ' photo-bg-frame--out'}${ready ? ' is-ready' : ''}`}
      style={{ backgroundImage: `url(${src})` }}
    />
  );
}

function App() {
  // The rotating footer taglines + credit belong to the plain home view only.
  // Whenever any page, card, popup or drawer is open, flag <body> so the CSS
  // can hide the whole footer (works even where :has() is unsupported).
  useEffect(() => {
    const SEL = '.guide-overlay, .sp-page, .sl-root, .ap-page, .lyrics-modal-overlay, .playlist-modal-overlay, .drawer.is-open, .gate-overlay, [aria-modal="true"]';
    let raf = 0;
    const check = () => {
      raf = 0;
      document.body.classList.toggle('overlay-open', !!document.body.querySelector(SEL));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(check); };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    check();
    return () => { mo.disconnect(); cancelAnimationFrame(raf); document.body.classList.remove('overlay-open'); };
  }, []);

  const [mode, setMode] = useState('default'); // 'default' | 'recommended'
  const [playRequest, setPlayRequest] = useState(null);
  // Like / add-to-playlist for the Recommended cards are handled by the Player
  // (single source of truth for liked songs + the playlist picker).
  const playerApiRef = useRef(null);
  const [likedIdList, setLikedIdList] = useState([]);
  const likedIds = useMemo(() => new Set(likedIdList), [likedIdList]);
  const recoToTrack = (it) => ({ id: it.id, title: it.title, channel: it.channel || it.subtitle || null, duration: it.durationSeconds });
  const toggleRecoLike = useCallback((it) => playerApiRef.current?.toggleLike(recoToTrack(it)), []);
  const addRecoToPlaylist = useCallback((it) => playerApiRef.current?.addToPlaylist(recoToTrack(it)), []);
  const [currentTrackId, setCurrentTrackId] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [bgIndex, setBgIndex] = useState(() => {
    const mobile = typeof window !== 'undefined' && window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
    return 1 + Math.floor(Math.random() * (mobile ? TOTAL_BG_PHOTOS_MOBILE : TOTAL_BG_PHOTOS));
  });

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

  // Remember the photo that was showing so the new one can fade in over it.
  const bgSrc = isMobile ? `/bg/mobile/${bgIndex}.jpg` : `/bg/${bgIndex}.jpg`;
  const bgHist = useRef({ cur: bgSrc, prev: null });
  if (bgHist.current.cur !== bgSrc) bgHist.current = { cur: bgSrc, prev: bgHist.current.cur };
  const bgPrevSrc = bgHist.current.prev;

  // If the viewport crosses the mobile breakpoint (resize, rotate, devtools
  // toggle), keep bgIndex valid for whichever photo set is now active
  // instead of pointing past the end of a shorter set.
  useEffect(() => {
    setBgIndex((prev) => ((prev - 1) % totalBgPhotos) + 1);
  }, [totalBgPhotos]);

  // Called by Player whenever the currently-playing track changes (new
  // song, next, previous, autoplay chain, etc.) — purely additive, doesn't
  // touch any of Player's own playback logic.
  // Random order, no repeats: a shuffled "deck" of every photo is dealt one
  // by one, and only reshuffled once all photos have been shown (the first
  // photo of a new deck is never the one that was just on screen).
  const bgDeckRef = useRef({ total: 0, cards: [] });
  const advanceBackground = useCallback(() => {
    setBgIndex((prev) => {
      const deck = bgDeckRef.current;
      if (deck.total !== totalBgPhotos) {
        deck.total = totalBgPhotos;
        deck.cards = [];
      }
      if (!deck.cards.length) {
        const cards = Array.from({ length: totalBgPhotos }, (_, i) => i + 1);
        for (let i = cards.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [cards[i], cards[j]] = [cards[j], cards[i]];
        }
        if (cards.length > 1 && cards[cards.length - 1] === prev) {
          const k = Math.floor(Math.random() * (cards.length - 1));
          [cards[cards.length - 1], cards[k]] = [cards[k], cards[cards.length - 1]];
        }
        deck.cards = cards;
      }
      let next = deck.cards.pop();
      if (next === prev && deck.cards.length) {
        const alt = deck.cards.pop();
        deck.cards.push(next);
        next = alt;
      }
      return next;
    });
  }, [totalBgPhotos]);

  // Re-tint the player orb to match whichever backdrop photo is now
  // showing, so every track feels a little visually distinct instead of
  // the glow always being the same static gold/red. Sets CSS custom
  // properties on the root element, which the orb's glow/accent styles
  // read (with the static stripe colors as a fallback).
  useEffect(() => {
    let cancelled = false;
    const src = isMobile ? `/bg/mobile/${bgIndex}.jpg` : `/bg/${bgIndex}.jpg`;
    extractDominantColor(src).then((rgb) => {
      if (cancelled || !rgb) return;
      const { r, g, b } = rgb;
      const soften = (c) => Math.min(255, Math.round(c + (255 - c) * 0.35));
      document.documentElement.style.setProperty('--track-accent', `rgb(${r}, ${g}, ${b})`);
      document.documentElement.style.setProperty(
        '--track-accent-soft',
        `rgb(${soften(r)}, ${soften(g)}, ${soften(b)})`
      );
      document.documentElement.style.setProperty(
        '--track-accent-glow',
        `rgba(${r}, ${g}, ${b}, 0.65)`
      );
    });
    return () => {
      cancelled = true;
    };
  }, [bgIndex, isMobile]);

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

  const handleTrackChange = useCallback((id) => {
    setCurrentTrackId(id);
    advanceBackground(id);
  }, [advanceBackground]);

  // A recommended card was clicked: hand the track to the (unchanged) Player.
  const playRecommended = useCallback((t) => {
    setPlayRequest({
      track: { id: t.id, title: t.title, channel: t.channel, duration: t.durationSeconds },
      nonce: Date.now(),
    });
  }, []);

  return (
    <div className="App shell">
      {/* Full-bleed photo backdrop — swaps to a new frame from /bg on every
          track change, crossfading via the key-based remount below. */}
      <div className="photo-bg" aria-hidden="true">
        {bgPrevSrc && <BgFrame key={`out-${bgPrevSrc}`} src={bgPrevSrc} incoming={false} />}
        <BgFrame key={`in-${bgSrc}`} src={bgSrc} incoming />
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
            <span className="brand">RaunakNama</span>
          </div>
        </div>

        <div className="topbar-right">
          <NavClock />
          <ModeMenu mode={mode} onChange={setMode} />
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
        <Player
          onTrackChange={handleTrackChange}
          playRequest={playRequest}
          onPlayerApi={(api) => { playerApiRef.current = api; }}
          onLikedChange={setLikedIdList}
          menuOpen={menuOpen}
          onCloseMenu={closeMenu}
          backgroundImageUrl={isMobile ? `/bg/mobile/${bgIndex}.jpg` : `/bg/${bgIndex}.jpg`}
        />
        {mode === 'recommended' && (
          <div className="reco-embed dash">
            <RecommendedGrid
              currentId={currentTrackId}
              likedIds={likedIds}
              onToggleLike={toggleRecoLike}
              onAddToPlaylist={addRecoToPlaylist}
              onSelect={playRecommended}
              onWarm={(t) => warmStream(t.id)}
            />
          </div>
        )}
      </main>

      <GuideButton />

      <div className="site-footer">
        <footer className="foot">
          <FooterTagline />
        </footer>

        <div className="foot-copyright">
          <span className="foot-credit">
            Crafted with <span className="foot-heart" aria-hidden="true"><Icon name="heart" style={{ fill: "currentColor", color: "#e0425a" }} /></span> by{' '}
            <span className="foot-credit-name">Raunak</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export default App;
