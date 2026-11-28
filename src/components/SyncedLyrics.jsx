import React, { useEffect, useMemo, useRef, useState } from "react";
import "./SyncedLyrics.css";
import Icon from "./Icon";
import ScriptToggle from "./ScriptToggle";

// Full-screen, time-synced lyrics view. Only ever mounted when the listener
// explicitly chooses "Synced view" from the lyrics panel — the normal player
// and the browser's own full-screen mode never show this effect.

const COVER_STEPS = ["hq720", "hqdefault", "mqdefault"];

function Cover({ id }) {
  const [step, setStep] = useState(0);
  useEffect(() => setStep(0), [id]);
  if (!id || step >= COVER_STEPS.length) {
    return <span className="sl-cover-fallback" aria-hidden="true"><Icon name="music" /></span>;
  }
  return (
    <img
      key={`${id}-${step}`}
      src={`https://i.ytimg.com/vi/${id}/${COVER_STEPS[step]}.jpg`}
      alt=""
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setStep((n) => n + 1)}
    />
  );
}

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

const cleanArtist = (c) => (c || "").replace(/\s*-\s*topic\s*$/i, "").trim();

export default function SyncedLyrics({
  track,
  lines,
  loading,
  currentTime,
  duration,
  isPlaying,
  onClose,
  onSeek,
  onTogglePlay,
  onPrev,
  onNext,
  onShowPlain,
  scriptMode = "orig",
  onScriptMode,
}) {
  const scrollerRef = useRef(null);
  const lineRefs = useRef([]);
  const userScrollUntil = useRef(0);

  const hasLines = Array.isArray(lines) && lines.length > 0;

  // Active line = the last one whose timestamp has been reached.
  const activeIndex = useMemo(() => {
    if (!hasLines) return -1;
    const t = currentTime + 0.3; // tiny look-ahead so the highlight lands on the beat
    let lo = 0;
    let hi = lines.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found;
  }, [lines, currentTime, hasLines]);

  // Keep the active line centred — unless the listener is scrolling by hand.
  useEffect(() => {
    if (activeIndex < 0) return;
    if (Date.now() < userScrollUntil.current) return;
    const el = lineRefs.current[activeIndex];
    const box = scrollerRef.current;
    if (!el || !box) return;
    const target = el.offsetTop - box.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
    box.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [activeIndex]);

  // New track -> back to the top.
  useEffect(() => {
    lineRefs.current = [];
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [track?.id]);

  // Esc closes; page behind doesn't scroll.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const pauseAutoScroll = () => { userScrollUntil.current = Date.now() + 3500; };

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const artist = cleanArtist(track?.channel);

  return (
    <div className="sl-root" role="dialog" aria-modal="true" aria-label="Synced lyrics">
      <div className="sl-bg" aria-hidden="true">
        {track?.id && (
          <img src={`https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`} alt="" referrerPolicy="no-referrer" />
        )}
      </div>
      <div className="sl-shade" aria-hidden="true" />

      <button type="button" className="sl-close" onClick={onClose} aria-label="Close synced lyrics">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>

      {onScriptMode && hasLines && <ScriptToggle mode={scriptMode} onChange={onScriptMode} className="sl-script" />}

      <div className="sl-layout">
        <section className="sl-side">
          <div className={`sl-cover ${isPlaying ? "is-playing" : ""}`}>
            <Cover id={track?.id} />
          </div>
          <div className="sl-info">
            <h2 className="sl-title" title={track?.title}>{track?.title}</h2>
            {artist && <p className="sl-artist">{artist}</p>}
          </div>

          <div className="sl-controls">
            <div className="sl-seek">
              <span>{fmt(currentTime)}</span>
              <input
                type="range"
                min="0"
                max={safeDuration}
                step="1"
                value={Math.min(currentTime, safeDuration)}
                onChange={(e) => onSeek(Number(e.target.value))}
                aria-label="Seek"
              />
              <span>{fmt(safeDuration)}</span>
            </div>
            <div className="sl-buttons">
              <button type="button" className="sl-btn" onClick={onPrev} aria-label="Previous track">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
              </button>
              <button type="button" className="sl-btn sl-btn--main" onClick={onTogglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
                {isPlaying ? (
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                )}
              </button>
              <button type="button" className="sl-btn" onClick={onNext} aria-label="Next track">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>
              </button>
            </div>
          </div>
        </section>

        <section className="sl-lyrics-col">
          {loading && (
            <div className="sl-state"><span className="sl-spinner" aria-hidden="true" /><p>Fetching lyrics…</p></div>
          )}

          {!loading && !hasLines && (
            <div className="sl-state">
              <p className="sl-state-title">Synced lyrics aren’t available for this song.</p>
              <p className="sl-state-sub">You can still read the plain lyrics if they exist.</p>
              <button type="button" className="sl-plain-btn" onClick={onShowPlain}>View plain lyrics</button>
            </div>
          )}

          {!loading && hasLines && (
            <div
              className="sl-scroller"
              ref={scrollerRef}
              onWheel={pauseAutoScroll}
              onTouchMove={pauseAutoScroll}
              onPointerDown={pauseAutoScroll}
            >
              <div className="sl-pad" aria-hidden="true" />
              {lines.map((l, i) => {
                const state = i === activeIndex ? "is-active" : i < activeIndex ? "is-past" : "is-future";
                const dist = Math.min(Math.abs(i - Math.max(activeIndex, 0)), 4);
                return (
                  <button
                    key={`${l.time}-${i}`}
                    type="button"
                    ref={(el) => { lineRefs.current[i] = el; }}
                    className={`sl-line ${state}`}
                    data-dist={dist}
                    onClick={() => { userScrollUntil.current = 0; onSeek(l.time); }}
                  >
                    <span dir="auto">{l.text || <Icon name="music" />}</span>
                  </button>
                );
              })}
              <div className="sl-pad" aria-hidden="true" />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
