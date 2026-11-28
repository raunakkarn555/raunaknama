import React, { useEffect, useMemo, useRef, useState } from "react";
import "./FullPlayer.css";
import ScriptToggle from "./ScriptToggle";
import { createVisualizer, loadVizMode, saveVizMode, VIZ_MODES } from "../lib/visualizer";
import { loadCrackle, saveCrackle, startCrackle, stopCrackle } from "../lib/vinylCrackle";

// Full-page "now playing" view. Opened from the expand button in the player dock.
// It only re-uses state/handlers that already live in Player.jsx (passed in as props),
// so playback behaves exactly the same as in the compact player.

// YouTube VIDEO thumbnails (i.ytimg.com frames / placeholders) are never used. The disc shows the
// song's REAL cover (album art) when there is one, and the RaunakNama logo in every other case.
const isYtimg = (u) => /(^|\/\/)(i\d?\.ytimg\.com|img\.youtube\.com)\//.test(u || "");

function Cover({ src }) {
  const real = src && !isYtimg(src) ? src : null;
  // phase: 0 = loading the cover, 1 = failed once (logo while waiting), 2 = one retry, 3 = gave up (logo)
  const [phase, setPhase] = useState(0);
  useEffect(() => setPhase(0), [real]);
  useEffect(() => {
    if (phase !== 1) return undefined;
    const t = setTimeout(() => setPhase(2), 4000);
    return () => clearTimeout(t);
  }, [phase]);

  if (real && (phase === 0 || phase === 2)) {
    return (
      <img
        key={`${real}-${phase}`}
        className="fp-cover-img"
        src={real}
        alt=""
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setPhase((p) => (p === 0 ? 1 : 3))}
      />
    );
  }
  // No real cover (yet / at all): the logo, always.
  return (
    <span className="fp-brand" role="img" aria-label="RaunakNama">
      <span className="fp-brand-pole" aria-hidden="true" />
    </span>
  );
}

/** One line of text that fits its box: if it is too long it scrolls in ONE direction (right to left, looping), otherwise it just sits centred. */
const MARQUEE_GAP = 48; // px between the end of the text and its repeat
function MarqueeText({ text }) {
  const wrapRef = useRef(null);
  const itemRef = useRef(null);
  const [shift, setShift] = useState(0); // distance of one full loop; 0 = fits, no marquee
  useEffect(() => {
    const measure = () => {
      const w = wrapRef.current;
      const it = itemRef.current;
      if (!w || !it) return;
      const textW = it.getBoundingClientRect().width;
      setShift(textW > w.clientWidth + 2 ? Math.round(textW + MARQUEE_GAP) : 0);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && wrapRef.current) ro.observe(wrapRef.current);
    if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {});
    return () => ro?.disconnect();
  }, [text]);
  const style = shift ? { "--shift": `-${shift}px`, "--dur": `${Math.max(7, shift / 40)}s` } : undefined;
  return (
    <span ref={wrapRef} className={`fp-marq ${shift ? "is-marquee" : ""}`} title={text}>
      <span className="fp-marq-track" style={style}>
        <span ref={itemRef} className="fp-marq-item">{text}</span>
        {shift ? <span className="fp-marq-item" aria-hidden="true">{text}</span> : null}
      </span>
    </span>
  );
}

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
const cleanArtist = (c) => (c || "").replace(/\s*-\s*topic\s*$/i, "").trim();

const svg = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
const BackIcon = () => (<svg {...svg}><polyline points="15 18 9 12 15 6" /></svg>);
const CloseIcon = () => (<svg {...svg}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>);

export default function FullPlayer({
  track,
  coverUrl,
  backgroundImageUrl,
  eyebrow,
  subtitle,
  isPlaying,
  isTrackLoading,
  currentTime,
  duration,
  volume,
  shuffle,
  autoplay,
  repeatOne,
  liked,
  shuffleDisabled,
  syncedLines,
  lyricsLoading,
  onClose,
  onTogglePlay,
  onPrev,
  onNext,
  onSeek,
  onVolume,
  onToggleShuffle,
  onToggleAutoplay,
  onToggleRepeat,
  onToggleLike,
  onOpenSynced,
  onOpenLyrics,
  scriptMode = "orig",
  onScriptMode,
  scriptEnabled = false,
  icons,
}) {
  const { PlayIcon, PauseIcon, PrevIcon, NextIcon, ShuffleIcon, AutoplayIcon, RepeatOneIcon, HeartIcon, MicIcon, SyncIcon, LoadingSpinnerIcon, VolumeIcon } = icons;

  // Esc closes the view.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keyboard: Space = play/pause, ←/→ = seek 5 s (ignored while a button/slider has focus).
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "BUTTON" || tag === "TEXTAREA") return;
      if (e.code === "Space") { e.preventDefault(); onTogglePlay(); }
      else if (e.key === "ArrowRight") onSeek(Math.min(duration || 0, currentTime + 5));
      else if (e.key === "ArrowLeft") onSeek(Math.max(0, currentTime - 5));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onTogglePlay, onSeek, currentTime, duration]);

  // Touch: swipe down from the top area (grab handle / header) closes the view.
  const touchRef = React.useRef(null);
  const onTouchStart = (e) => {
    const t = e.touches[0];
    touchRef.current = t.clientY < 140 ? { y: t.clientY } : null;
  };
  const onTouchEnd = (e) => {
    const st = touchRef.current;
    touchRef.current = null;
    if (st && e.changedTouches[0].clientY - st.y > 90) onClose();
  };

  // Lock page scroll underneath while the view is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Vinyl crackle (optional, remembered) + audio visualizer (bars / wave / off, remembered).
  const [crackle, setCrackle] = useState(loadCrackle);
  const [vizMode, setVizMode] = useState(loadVizMode);
  useEffect(() => {
    // Never run the crackle's own audio output while the screen is locked / the app is in the background:
    // it must not compete with the song or the lock-screen media card.
    const sync = () => { if (crackle && isPlaying && !document.hidden) startCrackle(); else stopCrackle(); };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [crackle, isPlaying]);
  useEffect(() => () => stopCrackle(), []);
  const toggleCrackle = () => setCrackle((v) => { saveCrackle(!v); return !v; });
  const cycleViz = () => setVizMode((m) => { const n = VIZ_MODES[(VIZ_MODES.indexOf(m) + 1) % VIZ_MODES.length]; saveVizMode(n); return n; });
  const [scriptOpen, setScriptOpen] = useState(false);
  const vizCanvasRef = useRef(null);
  const vizStateRef = useRef({ mode: vizMode, playing: isPlaying });
  vizStateRef.current = { mode: vizMode, playing: isPlaying };
  useEffect(() => {
    if (!vizCanvasRef.current) return undefined;
    const v = createVisualizer(vizCanvasRef.current, () => vizStateRef.current);
    return () => v.destroy();
  }, []);

  const hasSynced = !!(syncedLines && syncedLines.length);
  const liveLine = useMemo(() => {
    if (!hasSynced) return "";
    let cur = "";
    for (const l of syncedLines) { if (l.time <= currentTime + 0.25) cur = l.text; else break; }
    return cur;
  }, [hasSynced, syncedLines, currentTime]);

  const pct = duration ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className="fp-root" role="dialog" aria-modal="true" aria-label="Full player view" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {/* Vintage backdrop: the same photo as the app, just quieter + warm film tone */}
      <div className="fp-bg" aria-hidden="true">
        {backgroundImageUrl && <div className="fp-bg-img" style={{ backgroundImage: `url("${backgroundImageUrl}")` }} />}
        <div className="fp-bg-tint" />
        <div className="fp-bg-vignette" />
        <div className="fp-bg-grain" />
      </div>
      <div className="fp-frame" aria-hidden="true" />
      <canvas ref={vizCanvasRef} className={`fp-viz ${vizMode === "off" ? "is-off" : ""}`} aria-hidden="true" />

      <span className="fp-handle" aria-hidden="true" />
      <header className="fp-top">
        <button type="button" className="fp-icon-btn fp-back" onClick={onClose} aria-label="Back to player">
          <BackIcon /> <span className="fp-back-text">Back</span>
        </button>
        <div className="fp-top-title">
          <span className="fp-eyebrow">{eyebrow || "Now Playing"}</span>
          {subtitle && <span className="fp-subtitle line-clamp-1">{subtitle}</span>}
        </div>
        <button type="button" className="fp-icon-btn fp-close" onClick={onClose} aria-label="Close full view" title="Close">
          <CloseIcon />
        </button>
      </header>

      <main className="fp-main">
        <div className={`fp-orb ${isPlaying ? "is-spinning" : ""}`}>
          <span className={`orb-ring fp-ring ${isPlaying ? "is-active" : ""}`} />
          <span className={`orb-ring orb-ring--runner fp-ring ${isPlaying ? "is-active" : ""}`} />
          <div className="fp-disc">
            <Cover src={coverUrl} />
            <span className="fp-spindle" aria-hidden="true" />
          </div>
          {/* Tonearm: the needle lands on the outer groove when the song plays and lifts away on pause. It sits on the rim, so the cover stays visible. */}
          <div className={`fp-tonearm ${isPlaying ? "is-down" : ""}`} aria-hidden="true">
            <span className="fp-tonearm-base" />
            <span className="fp-tonearm-bar" />
            <span className="fp-tonearm-head"><span className="fp-tonearm-stylus" /></span>
          </div>
        </div>

        <div className="fp-info">
          <h2 className="fp-title" key={`t-${track.id}`}><MarqueeText text={track.title} /></h2>
          {(track.channel || track.artist) && <p className="fp-artist"><MarqueeText text={cleanArtist(track.artist || track.channel)} /></p>}
          {isTrackLoading && (
            <p className="fp-loading"><LoadingSpinnerIcon size={12} /> Loading&hellip;</p>
          )}
        </div>

        {/* Lyrics: obvious buttons + a live line */}
        <div className="fp-lyrics-row">
          <button
            type="button"
            className="fp-pill fp-pill--primary"
            onClick={onOpenSynced}
            disabled={!hasSynced}
            title={hasSynced ? "Open synced lyrics" : lyricsLoading ? "Fetching lyrics…" : "Synced lyrics aren't available for this song"}
          >
            <SyncIcon /> {hasSynced ? "Synced lyrics" : lyricsLoading ? "Fetching lyrics…" : "No synced lyrics"}
          </button>
          <button type="button" className="fp-pill" onClick={onOpenLyrics} title="Show lyrics text">
            <MicIcon /> Lyrics
          </button>
          <button
            type="button"
            className={`fp-pill fp-pill--icon ${liked ? "is-liked" : ""}`}
            onClick={onToggleLike}
            aria-label={liked ? "Unlike" : "Like"}
            aria-pressed={liked}
          >
            <HeartIcon filled={liked} />
          </button>
        </div>
        <p className="fp-live-line" aria-live="off">{liveLine && <span key={liveLine} className="fp-live-text" dir="auto">{liveLine}</span>}</p>
      </main>

      <footer className="fp-bottom">
        <div className="fp-seek">
          <span className="fp-time">{fmt(currentTime)}</span>
          <div className="fp-seek-wrap">
            <span className="fp-seek-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
            <input
              type="range"
              className="fp-seek-input"
              min="0"
              max={duration || 0}
              step="0.1"
              value={Math.min(currentTime, duration || 0)}
              onChange={(e) => onSeek(Number(e.target.value))}
              aria-label="Seek"
            />
          </div>
          <span className="fp-time">{fmt(duration)}</span>
        </div>

        <div className="fp-controls">
          <button type="button" className={`fp-ctrl ${shuffle ? "is-active" : ""}`} onClick={onToggleShuffle} disabled={shuffleDisabled} aria-label="Toggle shuffle" aria-pressed={shuffle}><ShuffleIcon /></button>
          <button type="button" className="fp-ctrl fp-ctrl--lg" onClick={onPrev} aria-label="Previous track"><PrevIcon /></button>
          <button type="button" className={`fp-play ${isTrackLoading ? "is-loading" : ""}`} onClick={onTogglePlay} aria-label={isTrackLoading ? "Loading" : isPlaying ? "Pause" : "Play"}>
            {isTrackLoading ? <LoadingSpinnerIcon /> : isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button type="button" className="fp-ctrl fp-ctrl--lg" onClick={onNext} aria-label="Next track"><NextIcon /></button>
          <button type="button" className={`fp-ctrl ${repeatOne ? "is-active" : ""}`} onClick={onToggleRepeat} aria-label={repeatOne ? "Repeat this song: on" : "Repeat this song: off"} aria-pressed={repeatOne}><RepeatOneIcon /></button>
        </div>

        <div className="fp-extra">
          {scriptEnabled && onScriptMode && (
            <>
              <button type="button" className={`fp-ctrl fp-ctrl--sm fp-script-btn ${scriptOpen || scriptMode !== "orig" ? "is-active" : ""}`} onClick={() => setScriptOpen((v) => !v)} aria-expanded={scriptOpen} aria-label="Lyrics script: Roman / Devanagari / Urdu" title="Lyrics script">
                <span aria-hidden="true">{"\u0905/A"}</span>
              </button>
              {scriptOpen && (
                <div className="fp-script-pop">
                  <ScriptToggle mode={scriptMode} onChange={(m) => { onScriptMode(m); setScriptOpen(false); }} />
                </div>
              )}
            </>
          )}
          <button type="button" className={`fp-ctrl fp-ctrl--sm ${autoplay ? "is-active" : ""}`} onClick={onToggleAutoplay} aria-label="Toggle autoplay" aria-pressed={autoplay}><AutoplayIcon /></button>
          <button type="button" className={`fp-ctrl fp-ctrl--sm ${crackle ? "is-active" : ""}`} onClick={toggleCrackle} aria-label={crackle ? "Vinyl crackle: on" : "Vinyl crackle: off"} aria-pressed={crackle} title={crackle ? "Vinyl crackle on" : "Vinyl crackle off"}>
            <svg {...svg}><path d="M3 12h2l2-6 3 12 3-9 2 5 2-2h4" /></svg>
          </button>
          <button type="button" className={`fp-ctrl fp-ctrl--sm ${vizMode !== "off" ? "is-active" : ""}`} onClick={cycleViz} aria-label={`Visualizer: ${vizMode}`} title={`Visualizer: ${vizMode} (tap to change)`}>
            {vizMode === "wave"
              ? <svg {...svg}><path d="M2 12c2-6 4-6 6 0s4 6 6 0 4-6 8 0" /></svg>
              : <svg {...svg}><line x1="5" y1="20" x2="5" y2="12" /><line x1="10" y1="20" x2="10" y2="5" /><line x1="15" y1="20" x2="15" y2="9" /><line x1="20" y1="20" x2="20" y2="14" />{vizMode === "off" && <line x1="3" y1="3" x2="21" y2="21" />}</svg>}
          </button>
          <div className="fp-volume">
            <VolumeIcon />
            <input type="range" className="fp-volume-input" min="0" max="1" step="0.01" value={volume} onChange={onVolume} aria-label="Volume" style={{ "--fill": `${Math.round(volume * 100)}%` }} />
          </div>
        </div>
      </footer>
    </div>
  );
}
