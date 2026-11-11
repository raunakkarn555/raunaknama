import { useCallback, useEffect, useRef, useState } from "react";
import "./Dashboard.css";

const STREAM_ENDPOINT = "/api/stream";
const streamUrl = (token) => `${STREAM_ENDPOINT}?token=${encodeURIComponent(token)}`;

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

/* ------------------------------------------------------------------ *
 * Audio engine: a pool of two <audio> elements.
 *  - hover/focus "warms" the standby element (src + load()) so the CDN
 *    handshake and first chunks are already in flight before the click;
 *  - a click swaps to the warmed element, or maps src, calls load() and
 *    play() synchronously inside the user gesture if it wasn't warmed;
 *  - alternating elements avoids aborting a pending load on the one that
 *    is still audible.
 * ------------------------------------------------------------------ */
function useAudioEngine() {
  const pool = useRef([]);
  const active = useRef(0);
  const warmTimer = useRef(null);
  const [state, setState] = useState({
    item: null, playing: false, buffering: false, time: 0, duration: 0, error: false,
  });

  useEffect(() => {
    const els = [new Audio(), new Audio()];
    els.forEach((a) => {
      a.preload = "auto";
      a.dataset.token = "";
    });
    pool.current = els;

    const patchIfActive = (patch) => (e) => {
      if (e.target === pool.current[active.current]) setState((s) => ({ ...s, ...patch(e.target) }));
    };

    const handlers = {
      play: patchIfActive(() => ({ playing: true, error: false })),
      playing: patchIfActive(() => ({ playing: true, buffering: false })),
      pause: patchIfActive(() => ({ playing: false })),
      waiting: patchIfActive(() => ({ buffering: true })),
      canplay: patchIfActive(() => ({ buffering: false })),
      timeupdate: patchIfActive((a) => ({ time: a.currentTime })),
      durationchange: patchIfActive((a) => ({ duration: a.duration })),
      ended: patchIfActive(() => ({ playing: false, time: 0 })),
      error: patchIfActive((a) => (a.dataset.token ? { error: true, playing: false, buffering: false } : {})),
    };
    els.forEach((a) => Object.entries(handlers).forEach(([ev, fn]) => a.addEventListener(ev, fn)));

    return () => {
      clearTimeout(warmTimer.current);
      els.forEach((a) => {
        Object.entries(handlers).forEach(([ev, fn]) => a.removeEventListener(ev, fn));
        a.pause();
        a.removeAttribute("src");
        a.load();
      });
    };
  }, []);

  const standby = () => pool.current[1 - active.current];

  const prime = (el, token) => {
    if (el.dataset.token === token) return;
    el.dataset.token = token;
    el.src = streamUrl(token);
    el.load(); // opens the network socket right away (preload="auto")
  };

  const warm = useCallback((item) => {
    clearTimeout(warmTimer.current);
    warmTimer.current = setTimeout(() => {
      const el = standby();
      if (el && el.paused) prime(el, item.id);
    }, 80); // ignore drive-by cursor movement
  }, []);

  const cancelWarm = useCallback(() => clearTimeout(warmTimer.current), []);

  const play = useCallback((item) => {
    const prev = pool.current[active.current];
    const next = standby();
    if (!next) return;

    prev.pause();
    active.current = 1 - active.current;
    prime(next, item.id);

    setState({ item, playing: false, buffering: true, time: 0, duration: 0, error: false });
    next.currentTime = 0;
    // Called synchronously inside the click handler => allowed by autoplay policy.
    next.play().catch((err) => {
      if (err?.name === "AbortError") return; // superseded by a newer click
      setState((s) => ({ ...s, playing: false, buffering: false, error: true }));
    });
  }, []);

  const toggle = useCallback((item) => {
    const el = pool.current[active.current];
    if (el && el.dataset.token === item.id) {
      if (el.paused) el.play().catch(() => setState((s) => ({ ...s, error: true })));
      else el.pause();
    } else {
      play(item);
    }
  }, [play]);

  const seek = useCallback((t) => {
    const el = pool.current[active.current];
    if (el && Number.isFinite(t)) el.currentTime = t;
  }, []);

  return { ...state, warm, cancelWarm, toggle, seek };
}

/* ------------------------------------------------------------------ *
 * Piped API client (Recommended mode only)
 *  - tries each public instance in order and remembers the last one that
 *    worked, so a dead instance costs one timeout, not one per request;
 *  - override the list with VITE_PIPED_API_INSTANCES="https://a,https://b".
 *    NOTE: "kavin.rocks" is the Piped *frontend*; its API host is
 *    pipedapi.kavin.rocks.
 * ------------------------------------------------------------------ */
const DEFAULT_PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
  "https://pipedapi.leptons.xyz",
  "https://piped-api.garudalinux.org",
];
const PIPED_INSTANCES = (import.meta.env?.VITE_PIPED_API_INSTANCES || "")
  .split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
const INSTANCES = PIPED_INSTANCES.length ? PIPED_INSTANCES : DEFAULT_PIPED_INSTANCES;

// Every "shelf" in Recommended mode is one fresh search for one of these.
// Order and query wording are randomised per visit, so each refresh differs.
const SECTION_SEEDS = [
  { title: "Bollywood Hits", q: "bollywood hits" },
  { title: "Arijit Singh", q: "arijit singh" },
  { title: "Kishore Kumar", q: "kishore kumar" },
  { title: "Mohammed Rafi", q: "mohammed rafi" },
  { title: "Lata Mangeshkar", q: "lata mangeshkar" },
  { title: "Ghazal Nights", q: "ghazal jagjit singh" },
  { title: "Sufi Soul", q: "sufi songs" },
  { title: "90s Romance", q: "90s bollywood romantic" },
  { title: "Old Hindi Classics", q: "old hindi classics" },
  { title: "Hindi Lofi", q: "hindi lofi" },
  { title: "Atif Aslam", q: "atif aslam" },
  { title: "Shreya Ghoshal", q: "shreya ghoshal" },
  { title: "Sonu Nigam", q: "sonu nigam" },
  { title: "Udit Narayan", q: "udit narayan" },
  { title: "Kumar Sanu", q: "kumar sanu" },
  { title: "Alka Yagnik", q: "alka yagnik" },
  { title: "Jubin Nautiyal", q: "jubin nautiyal" },
  { title: "A. R. Rahman", q: "ar rahman" },
  { title: "Pritam Specials", q: "pritam songs" },
  { title: "Nusrat Fateh Ali Khan", q: "nusrat fateh ali khan" },
  { title: "Rahat Fateh Ali Khan", q: "rahat fateh ali khan" },
  { title: "Lucky Ali", q: "lucky ali" },
  { title: "KK Forever", q: "kk songs" },
  { title: "Mohit Chauhan", q: "mohit chauhan" },
  { title: "Punjabi Hits", q: "punjabi hit songs" },
  { title: "Heartbreak", q: "hindi sad songs" },
  { title: "Road Trip", q: "hindi road trip songs" },
  { title: "Party Mode", q: "bollywood party songs" },
  { title: "Wedding Season", q: "bollywood wedding songs" },
  { title: "Monsoon Mood", q: "hindi rain songs" },
  { title: "Late Night", q: "hindi late night songs" },
  { title: "Retro 70s", q: "70s bollywood songs" },
  { title: "Retro 80s", q: "80s bollywood songs" },
  { title: "Evergreen Duets", q: "bollywood duets" },
  { title: "Bhajan & Devotional", q: "bhajan" },
  { title: "Qawwali", q: "qawwali" },
  { title: "Indie India", q: "indian indie songs" },
  { title: "Acoustic Hindi", q: "hindi acoustic songs" },
  { title: "Workout Beats", q: "bollywood workout songs" },
  { title: "Love Songs", q: "hindi love songs" },
];
const QUERY_SUFFIXES = ["", " songs", " best", " hits", " evergreen", " top"];
const SECTION_SIZE = 12;   // cards per shelf
const MIN_NEW_PER_SECTION = 4;
const MAX_CONSECUTIVE_FAILS = 3;
const MAX_DRY_SECTIONS = 10; // shelves in a row with nothing new => stop
const PIPED_FILTER = "music_songs";
const REQUEST_TIMEOUT_MS = 6000;

let preferredInstance = 0;

async function pipedGet(path, params, signal) {
  const qs = new URLSearchParams(params).toString();
  let lastErr = new Error("No Piped instance reachable");
  for (let n = 0; n < INSTANCES.length; n++) {
    const idx = (preferredInstance + n) % INSTANCES.length;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${INSTANCES[idx]}${path}?${qs}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      preferredInstance = idx;
      return data;
    } catch (err) {
      if (signal?.aborted) throw err; // caller cancelled — don't fail over
      lastErr = err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr;
}

// Google-hosted covers end in "=w60-h60-..." / "=s120"; ask for 544px instead.
const hiRes = (url) =>
  typeof url === "string"
    ? url.replace(/=w\d+-h\d+[^/?]*$/, "=w544-h544-l90-rj").replace(/=s\d+[^/?]*$/, "=s544")
    : null;

const toTrack = (it) => {
  const id = /[?&]v=([\w-]{11})/.exec(it?.url || "")?.[1];
  if (!id || it.type !== "stream") return null;
  return {
    id,
    title: it.title || "Untitled",
    subtitle: (it.uploaderName || "Unknown artist").replace(/\s*-\s*Topic$/i, ""),
    channel: (it.uploaderName || "").replace(/\s*-\s*Topic$/i, ""), // field name Player/search use
    duration: it.duration > 0 ? fmt(it.duration) : null,
    durationSeconds: it.duration > 0 ? it.duration : null,
    thumbnailUrl: hiRes(it.thumbnail),
  };
};

/** Infinite scroll: fires `onNearBottom` when the window is within `offset`px of the end. */
function useNearBottom(onNearBottom, enabled, recheckKey, offset = 800) {
  const cb = useRef(onNearBottom);
  cb.current = onNearBottom;
  useEffect(() => {
    if (!enabled) return undefined;
    let raf = 0;
    const check = () => {
      raf = 0;
      const { scrollHeight } = document.documentElement;
      if (window.innerHeight + window.scrollY >= scrollHeight - offset) cb.current();
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(check); };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    onScroll(); // short first page that doesn't fill the viewport still triggers
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [enabled, offset, recheckKey]);
}

const shuffle = (arr) => {
  const r = arr.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};

/**
 * Endless feed of "shelves". Each shelf = one fresh Piped search (no `nextpage`
 * tokens — those only work on the instance that issued them, which broke
 * pagination whenever failover switched instances). Failed or unproductive
 * searches are skipped silently; an error shows only after repeated failures.
 */
function usePipedFeed() {
  const [sections, setSections] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | error | end
  const seen = useRef(new Set());
  const queue = useRef([]);
  const busy = useRef(false);
  const fails = useRef(0);
  const dry = useRef(0);
  const ctrlRef = useRef(null);
  const sectionNo = useRef(0);

  const nextSeed = () => {
    if (!queue.current.length) queue.current = shuffle(SECTION_SEEDS);
    return queue.current.pop();
  };

  const loadMore = useCallback(async () => {
    if (busy.current || status === "end") return;
    busy.current = true;
    setStatus("loading");
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const seed = nextSeed();
        const suffix = QUERY_SUFFIXES[Math.floor(Math.random() * QUERY_SUFFIXES.length)];
        let data;
        try {
          data = await pipedGet("/search", { q: seed.q + suffix, filter: PIPED_FILTER }, ctrl.signal);
          fails.current = 0;
        } catch (err) {
          if (ctrl.signal.aborted) throw err;
          fails.current += 1;
          if (fails.current >= MAX_CONSECUTIVE_FAILS) throw err;
          continue; // silently try another search
        }

        const fresh = [];
        for (const raw of data?.items || []) {
          const t = toTrack(raw);
          if (t && !seen.current.has(t.id)) fresh.push(t);
        }
        if (fresh.length >= MIN_NEW_PER_SECTION) {
          const picked = shuffle(fresh).slice(0, SECTION_SIZE);
          picked.forEach((t) => seen.current.add(t.id));
          dry.current = 0;
          sectionNo.current += 1;
          setSections((prev) => prev.concat({ key: `s${sectionNo.current}`, title: seed.title, items: picked }));
          setStatus("idle");
          return;
        }
        dry.current += 1;
        if (dry.current >= MAX_DRY_SECTIONS) { setStatus("end"); return; }
      }
      setStatus("idle"); // nothing usable this round; the next scroll check tries again
    } catch (err) {
      setStatus(ctrl.signal.aborted ? "idle" : "error");
    } finally {
      busy.current = false;
    }
  }, [status]);

  useEffect(() => () => { ctrlRef.current?.abort(); busy.current = false; }, []);

  const retry = useCallback(() => { fails.current = 0; setStatus("idle"); }, []);
  return { sections, status, loadMore, retry };
}

/* ------------------------------ UI ------------------------------ */

function PlayIcon({ playing }) {
  return playing ? (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
  );
}

function MediaCard({ item, engine }) {
  const isCurrent = engine.item?.id === item.id;
  const playing = isCurrent && engine.playing;
  return (
    <li
      className={`card ${isCurrent ? "is-current" : ""}`}
      onPointerEnter={() => engine.warm(item)}
      onPointerLeave={engine.cancelWarm}
    >
      <div className="card-art">
        {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" decoding="async" /> : <span className="art-fallback">♪</span>}
        <button
          type="button"
          className="fab"
          onFocus={() => engine.warm(item)}
          onClick={() => engine.toggle(item)}
          aria-label={`${playing ? "Pause" : "Play"} ${item.title} by ${item.subtitle}`}
        >
          <PlayIcon playing={playing} />
        </button>
      </div>
      <h3 className="card-title" title={item.title}>{item.title}</h3>
      <p className="card-sub" title={item.subtitle}>{item.subtitle}</p>
    </li>
  );
}

function SuggestionRow({ item, engine }) {
  const isCurrent = engine.item?.id === item.id;
  const playing = isCurrent && engine.playing;
  return (
    <li
      className={`row ${isCurrent ? "is-current" : ""}`}
      onPointerEnter={() => engine.warm(item)}
      onPointerLeave={engine.cancelWarm}
    >
      <button
        type="button"
        className="row-btn"
        onFocus={() => engine.warm(item)}
        onClick={() => engine.toggle(item)}
        aria-label={`${playing ? "Pause" : "Play"} ${item.title} by ${item.subtitle}`}
      >
        <span className="row-thumb">
          {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" decoding="async" /> : <span className="art-fallback">♪</span>}
        </span>
        <span className="row-meta">
          <span className="row-title">{item.title}</span>
          <span className="row-sub">{item.subtitle}</span>
        </span>
        <span className="row-time">{item.duration}</span>
        <span className="row-play"><PlayIcon playing={playing} /></span>
      </button>
    </li>
  );
}

function Dock({ engine }) {
  const { item, playing, buffering, time, duration, error } = engine;
  if (!item) return null;
  return (
    <footer className="dock" role="region" aria-label="Now playing">
      <div className="dock-track">
        <div className="dock-art">{item.thumbnailUrl && <img src={item.thumbnailUrl} alt="" />}</div>
        <div className="dock-meta">
          <p className="dock-title" title={item.title}>{item.title}</p>
          <p className="dock-sub">{error ? "Playback failed — try again" : item.subtitle}</p>
        </div>
      </div>
      <div className="dock-controls">
        <button type="button" className="dock-play" onClick={() => engine.toggle(item)} aria-label={playing ? "Pause" : "Play"}>
          {buffering && !error ? <span className="spinner" aria-hidden="true" /> : <PlayIcon playing={playing} />}
        </button>
        <div className="dock-seek">
          <span>{fmt(time)}</span>
          <input
            type="range"
            min="0"
            max={Number.isFinite(duration) && duration > 0 ? duration : 0}
            step="1"
            value={Math.min(time, duration || 0)}
            onChange={(e) => engine.seek(Number(e.target.value))}
            aria-label="Seek"
          />
          <span>{fmt(duration)}</span>
        </div>
      </div>
    </footer>
  );
}

const MODES = [
  { id: "default", label: "Default" },
  { id: "recommended", label: "Recommended" },
];

function ModeSwitch({ mode, onChange }) {
  return (
    <div className="mode-bar">
      <span className="mode-label" id="mode-label">Mode</span>
      <div className="mode-switch" role="radiogroup" aria-labelledby="mode-label" data-mode={mode}>
        <span className="mode-thumb" aria-hidden="true" />
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            className={`mode-btn ${mode === m.id ? "is-active" : ""}`}
            onClick={() => onChange(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RecoCard({ item, isCurrent, playing, onSelect, onWarm, onCancelWarm }) {
  // Whole card is the click target.
  return (
    <li
      className={`rc ${isCurrent ? "is-current" : ""}`}
      onPointerEnter={() => onWarm?.(item)}
      onPointerLeave={onCancelWarm}
    >
      <button
        type="button"
        className="rc-hit"
        onFocus={() => onWarm?.(item)}
        onClick={() => onSelect(item)}
        aria-label={`${playing ? "Pause" : "Play"} ${item.title} by ${item.subtitle}`}
      >
        <span className="rc-art">
          {item.thumbnailUrl
            ? <img src={item.thumbnailUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
            : <span className="art-fallback">♪</span>}
          {item.duration && <span className="rc-dur">{item.duration}</span>}
          <span className="rc-play"><PlayIcon playing={playing} /></span>
        </span>
        <span className="rc-title" title={item.title}>{item.title}</span>
        <span className="rc-artist" title={item.subtitle}>{item.subtitle}</span>
      </button>
    </li>
  );
}

/** Host-agnostic grid: the host decides how a picked track is played. */
export function RecommendedGrid({ currentId, playing = false, onSelect, onWarm, onCancelWarm }) {
  const { sections, status, loadMore, retry } = usePipedFeed();
  const enabled = status === "idle";
  // Re-subscribes (and re-checks position) each time a shelf lands, so the
  // first shelf loads immediately and a tall viewport keeps filling.
  useNearBottom(loadMore, enabled, sections.length);

  // Pre-resolve the first few cards of each new shelf (staggered) so the
  // first tap on a recommended track starts almost instantly.
  const warmRef = useRef(onWarm);
  warmRef.current = onWarm;
  useEffect(() => {
    const latest = sections[sections.length - 1];
    if (!latest) return undefined;
    const timers = latest.items.slice(0, 3).map((it, i) =>
      setTimeout(() => warmRef.current?.(it), 400 + i * 400)
    );
    return () => timers.forEach(clearTimeout);
  }, [sections.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="reco" aria-labelledby="reco-title">
      <header className="reco-head">
        <span className="reco-chip" aria-hidden="true" />
        <h2 id="reco-title" className="reco-title">Recommended For You</h2>
        <p className="reco-sub">Fresh picks every visit — keep scrolling.</p>
      </header>

      {sections.map((sec) => (
        <div className="reco-section" key={sec.key}>
          <h3 className="reco-section-title">{sec.title}</h3>
          <ul className="rc-grid">
            {sec.items.map((it) => (
              <RecoCard
                key={it.id}
                item={it}
                isCurrent={currentId === it.id}
                playing={currentId === it.id && playing}
                onSelect={onSelect}
                onWarm={onWarm}
                onCancelWarm={onCancelWarm}
              />
            ))}
          </ul>
        </div>
      ))}

      {status === "loading" && (
        <div className="reco-section" aria-hidden="true">
          <div className="reco-skel-title" />
          <ul className="rc-grid">
            {Array.from({ length: 6 }, (_, i) => <li key={i} className="rc rc-skel" />)}
          </ul>
        </div>
      )}
      {status === "error" && (
        <p className="reco-note">
          Couldn’t load more right now.{" "}
          <button type="button" className="rc-retry" onClick={retry}>Try again</button>
        </p>
      )}
      {status === "end" && <p className="reco-note">You’ve reached the end — for now.</p>}
    </section>
  );
}

export default function Dashboard({ endpoint = "/api/media-grid", onTrackChange }) {
  const engine = useAudioEngine();

  // Lets a host shell (App.jsx) react to track changes, e.g. rotate the backdrop.
  const onTrackChangeRef = useRef(onTrackChange);
  onTrackChangeRef.current = onTrackChange;
  const currentId = engine.item?.id;
  useEffect(() => { if (currentId) onTrackChangeRef.current?.(currentId); }, [currentId]);
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("loading");
  const [mode, setMode] = useState("default"); // "default" | "recommended"

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(endpoint, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { setItems(Array.isArray(d.items) ? d.items : []); setStatus("ready"); })
      .catch((e) => e.name !== "AbortError" && setStatus("error"));
    return () => ctrl.abort();
  }, [endpoint]);

  const jumpBackIn = items.slice(0, 6);
  const recommended = items.slice(6, 14);

  return (
    <div className={`dash ${engine.item ? "has-dock" : ""}`}>
      <main className="dash-main">
        <ModeSwitch mode={mode} onChange={setMode} />
        {mode === "recommended" && (
          <RecommendedGrid
            currentId={engine.item?.id}
            playing={engine.playing}
            onSelect={engine.toggle}
            onWarm={engine.warm}
            onCancelWarm={engine.cancelWarm}
          />
        )}
        {mode === "default" && status === "loading" && <p className="dash-note">Loading…</p>}
        {mode === "default" && status === "error" && <p className="dash-note">Couldn’t load your library.</p>}
        {mode === "default" && status === "ready" && (
          <>
            <section aria-labelledby="jbi">
              <h2 id="jbi" className="section-title">Jump Back In</h2>
              <ul className="grid">
                {jumpBackIn.map((it) => <MediaCard key={it.id} item={it} engine={engine} />)}
              </ul>
            </section>
            {recommended.length > 0 && (
              <section aria-labelledby="rec">
                <h2 id="rec" className="section-title">Recommended For You</h2>
                <ul className="rows">
                  {recommended.map((it) => <SuggestionRow key={it.id} item={it} engine={engine} />)}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
      <Dock engine={engine} />
    </div>
  );
}
