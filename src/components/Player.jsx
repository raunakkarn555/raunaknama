import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import Hls from "hls.js";
import "./Player.css";
import { audioEngine } from "../lib/audioEngine";
import { trackCache } from "../lib/trackCache";
import useMediaSession from "../hooks/useMediaSession";

// How long we trust a resolved stream URL client-side before re-resolving.
// Kept comfortably under the server's own 2h cache window (see
// STREAM_CACHE_TTL_MS in ytdlpService.mjs) so we basically never re-hit the
// backend for a track that's already been resolved this session — that's
// what makes prev/next feel instant instead of waiting on yt-dlp again.
const CLIENT_STREAM_CACHE_TTL_MS = 100 * 60 * 1000;

import {
  fetchStream,
  warmStream,
  peekStream,
  beginPlaybackResolve,
  endPlaybackResolve,
  whenPlaybackIdle,
  isLimitedMode,
} from "../streamClient";
import ArtistPage, { ArtistSearchCard } from "./ArtistPage";
import SyncedLyrics from "./SyncedLyrics";
import FullPlayer from "./FullPlayer";
import Icon from "./Icon";
import SearchHistory, { saveSearchQuery } from "./SearchHistory";
import ScriptToggle from "./ScriptToggle";
import { convertLyrics, scriptAvailability, SCRIPT_MODES, SCRIPT_STORAGE_KEY } from "../lib/script";
import AppDownloads from "./AppDownloads";
import { burstHearts } from "../lib/heartBurst";

const PREFETCH_AFTER_PLAY_MS = 250; // next-track pre-resolve starts this long after the current song begins playing
const BG_PLAYLIST_GAP_MS = 1500; // pause between sequential background playlist fetches
const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

// Crossfade duration between tracks — the outgoing track fades out on a
// secondary <audio> element while the incoming one fades in on the primary
// element, so there's real overlap instead of a hard cut.
const CROSSFADE_MS = 1500;
// Incoming tracks ramp up quickly so a pick is audible right away.
const FADE_IN_MS = 350;

// How many seconds before a track's natural end we proactively advance to
// the next track (see the "gapless background advance" note above
// handleTrackEnded for why this exists — kept equal to CROSSFADE_MS so the
// crossfade-out always has real remaining audio to bridge with).
const EARLY_ADVANCE_SECS = CROSSFADE_MS / 1000;

// Smoothly ramps an <audio> element's volume from `from` to `to` over
// `durationMs`, driven by requestAnimationFrame. `rafRef` is a ref used to
// track/cancel the in-flight ramp so a new one (e.g. a rapid track skip)
// doesn't fight with a previous one still running.
//
// IMPORTANT (background-tab fix): browsers throttle/suspend
// requestAnimationFrame almost entirely once a tab is backgrounded (mobile
// browsers do this even more aggressively than desktop). Since every track
// change fades the new track in from volume 0 (see the crossfade logic
// below), a ramp that starts — or is still running — while the tab is
// hidden would get stuck partway (often stuck at 0), so the track plays but
// stays silent until the user switches back to the tab. To guarantee audio
// is always audible regardless of tab visibility, this now:
//   1. Skips the animation entirely and jumps straight to the target volume
//      if the tab is already hidden when the ramp is requested.
//   2. Listens for the tab being hidden mid-ramp and immediately snaps to
//      the target volume instead of leaving it stranded.
const rampAudioVolume = (el, from, to, durationMs, rafRef, onDone) => {
  if (!el) return;
  if (rafRef.current) cancelAnimationFrame(rafRef.current);
  const clamp = (v) => Math.min(1, Math.max(0, v));

  const finish = () => {
    try {
      el.volume = clamp(to);
    } catch (err) {
      // Element may already be detached/gone — nothing to finish.
    }
    if (onDone) onDone();
  };

  // Tab is already backgrounded — rAF won't reliably run, so don't even
  // start the animation; just apply the end volume immediately so the
  // track is audible right away.
  if (typeof document !== "undefined" && document.hidden) {
    finish();
    return;
  }

  const start = performance.now();
  try {
    el.volume = clamp(from);
  } catch (err) {
    // Element may already be detached/gone — nothing to animate.
    return;
  }

  const onVisibilityChange = () => {
    if (document.hidden) {
      // Tab got backgrounded mid-fade — stop waiting on rAF and snap
      // straight to the target volume so sound doesn't get stuck silent.
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      finish();
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    try {
      el.volume = clamp(from + (to - from) * t);
    } catch (err) {
      rafRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      return;
    }
    if (t < 1) {
      rafRef.current = requestAnimationFrame(step);
    } else {
      rafRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (onDone) onDone();
    }
  };
  rafRef.current = requestAnimationFrame(step);
};


// Never show tool / provider names in the UI.
const scrubBrand = (text) =>
  String(text ?? "").replace(/yt-?dlp/gi, "the streaming service").replace(/youtube/gi, "the source");

const formatTime = (secs) => {
  if (!secs || Number.isNaN(secs) || !Number.isFinite(secs)) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
};

// Fires a tiny haptic tick on play/pause/skip taps, mobile only (silently
// does nothing wherever navigator.vibrate isn't supported, e.g. desktop
// browsers and iOS Safari). Wrapped in try/catch since some browsers throw
// rather than no-op when called from a context they don't like.
const triggerHaptic = (ms = 12) => {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(ms);
    }
  } catch (err) {
    // Unsupported/blocked — not worth surfacing to the listener.
  }
};

const shuffledIndices = (length) => {
  const arr = Array.from({ length }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

const BackIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
  </svg>
);

// Cover art with a graceful fallback chain (hq720 -> hqdefault -> placeholder).
const COVER_SIZES = ["hq720", "hqdefault", "mqdefault"];
function SearchCover({ id, src }) {
  // `src` = square album art of a music "song" result; the YouTube video
  // thumbnails stay as the fallback chain behind it.
  const [step, setStep] = useState(0);
  const sources = src ? [src, ...COVER_SIZES.map((z) => `https://i.ytimg.com/vi/${id}/${z}.jpg`)] : null;
  const total = sources ? sources.length : COVER_SIZES.length;
  if (step >= total) return <span className="sp-cover-fallback" aria-hidden="true"><Icon name="music" /></span>;
  return (
    <img
      src={sources ? sources[step] : `https://i.ytimg.com/vi/${id}/${COVER_SIZES[step]}.jpg`}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setStep((n) => n + 1)}
    />
  );
}

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
    <path d="M7 4.5v15l13-7.5-13-7.5z" />
  </svg>
);

const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
    <path d="M6 4.5h4v15H6v-15zM14 4.5h4v15h-4v-15z" />
  </svg>
);

// Small ring spinner shown on the orb / next to the track while a stream
// is being fetched (yt-dlp resolve), so it's obvious something's loading.
const LoadingSpinnerIcon = ({ size = 20 }) => (
  <svg
    className="loading-spinner-icon"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
    <path
      d="M21 12a9 9 0 0 0-9-9"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    />
  </svg>
);

const PrevIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M6 5h2v14H6V5zm2.5 7L20 5v14L8.5 12z" />
  </svg>
);

const NextIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M16 5v14h2V5h-2zM3.5 5v14L15 12 3.5 5z" />
  </svg>
);

const ShuffleIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 5h3.5c2 0 3 1 4.5 3l5 8c1.5 2 2.5 3 4.5 3H21" />
    <path d="M4 19h3.5c2 0 3-1 4.5-3l.7-1.1" />
    <path d="M17.5 5H21M21 5v3.5M21 5l-4.5 4.5" />
    <path d="M17.5 19H21M21 19v-3.5M21 19l-4.5-4.5" />
  </svg>
);

const AutoplayIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <path d="M7 22l-4-4 4-4" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
);

const RepeatOneIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <path d="M7 22l-4-4 4-4" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    <path d="M11 10l1.5-1v6" />
  </svg>
);

const VolumeIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path d="M4 9v6h4l5 5V4L8 9H4zm11.5 3a4.5 4.5 0 0 0-2.3-3.94v7.87A4.5 4.5 0 0 0 15.5 12z" />
  </svg>
);

const ChevronIcon = ({ open }) => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s ease" }}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.35-4.35" />
  </svg>
);

const EqualizerIcon = ({ active }) => (
  <span className={`eq-icon ${active ? "is-active" : ""}`} aria-hidden="true">
    <span className="eq-bar" />
    <span className="eq-bar" />
    <span className="eq-bar" />
  </span>
);

// Small badge icon for search results that are already sitting in one of
// the listener's own radio playlists — just a stacked-lines glyph, kept
// intentionally simple/tiny since it's rendered inline with text.
const PlaylistBadgeIcon = () => (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M4 6h13M4 12h13M4 18h8" />
    <circle cx="20" cy="16" r="2.4" fill="currentColor" stroke="none" />
  </svg>
);

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

// --- Icons for the local (on-device) custom playlist feature ---

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const SaveIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v10" />
    <path d="M7 10l5 5 5-5" />
    <path d="M5 19h14" />
  </svg>
);

const UploadIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 15V5" />
    <path d="M7 10l5-5 5 5" />
    <path d="M5 19h14" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="M6 7l1 13h10l1-13" />
  </svg>
);

const DeviceIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

const OfflineIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 2l20 20" />
    <path d="M8.5 16.5a5 5 0 0 1 5.6-1.1" />
    <path d="M5 12.5a10 10 0 0 1 3.5-2.3" />
    <path d="M11.5 8.06A10 10 0 0 1 19 11.5" />
    <path d="M15.5 5.5A14 14 0 0 0 4 9" />
    <circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" />
  </svg>
);

// --- Icons for like/favorite, sleep timer, "surprise me", and history ---

const HeartIcon = ({ filled }) => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 21s-7.5-4.6-10-9.3C.6 8.4 2.3 5 5.7 5c2 0 3.4 1.1 4.3 2.4C10.9 6.1 12.3 5 14.3 5c3.4 0 5.1 3.4 3.7 6.7C19.5 16.4 12 21 12 21z" />
  </svg>
);

const MoonIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
  </svg>
);

const DiceIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="16" cy="8" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="8" cy="16" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="16" cy="16" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

const HistoryIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
    <path d="M12 7v5l4 2" />
  </svg>
);

// Lyrics — mic icon, used on the "Lyrics" toggle button and empty/loading
// states inside the lyrics panel.
const MicIcon = ({ size = 16 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 15a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 0 0-7 0v5.5A3.5 3.5 0 0 0 12 15z" />
    <path d="M6.5 11a5.5 5.5 0 0 0 11 0" />
    <path d="M12 16.5V20" />
    <path d="M9 20h6" />
  </svg>
);

// LRC parser — turns a raw LRC blob (lines like "[01:23.45]Some lyric text",
// with optional multiple timestamps per line) into a sorted, deduped array
// of { time (seconds), text }. Lines with no timestamp — occasional stray
// metadata like [ar:Artist] or [00:00.00] blank leaders — are ignored.
const LRC_LINE_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
const parseLRC = (raw) => {
  if (!raw || typeof raw !== "string") return [];
  const lines = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    LRC_LINE_RE.lastIndex = 0;
    const timestamps = [];
    let match;
    while ((match = LRC_LINE_RE.exec(rawLine))) {
      const mins = parseInt(match[1], 10);
      const secs = parseInt(match[2], 10);
      const frac = match[3] ? Number(`0.${match[3]}`) : 0;
      timestamps.push(mins * 60 + secs + frac);
    }
    if (!timestamps.length) continue;
    const text = rawLine.replace(LRC_LINE_RE, "").trim();
    for (const time of timestamps) {
      lines.push({ time, text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
};

// --- Playlist share links ---
// A custom playlist is packed into a compact, URL-safe code (deflate-compressed
// where the browser supports it) so it can be shared as a normal link:
//   https://<site>/?pl=<code>
// Whoever opens the link gets a "Save this playlist?" prompt and, on
// accept, it becomes one of THEIR on-device custom playlists. Nothing is
// ever stored on the server — the playlist lives entirely inside the link.
const SHARE_MAX_TRACKS = 300;
const YT_ID_RE = /^[\w-]{11}$/;

const bytesToB64Url = (bytes) => {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64UrlToBytes = (str) => {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

const encodePlaylistShare = async (playlist) => {
  const json = JSON.stringify({
    v: 1,
    n: String(playlist.label || "Shared playlist").slice(0, 60),
    t: playlist.tracks
      .filter((t) => t && YT_ID_RE.test(t.id || ""))
      .slice(0, SHARE_MAX_TRACKS)
      .map((t) => [t.id, t.title || "", t.channel || ""]),
  });
  const raw = new TextEncoder().encode(json);
  if (typeof CompressionStream !== "undefined") {
    try {
      const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      const packed = new Uint8Array(await new Response(stream).arrayBuffer());
      return `z${bytesToB64Url(packed)}`;
    } catch {
      /* fall through to the uncompressed form */
    }
  }
  return `r${bytesToB64Url(raw)}`;
};

const decodePlaylistShare = async (code) => {
  try {
    if (!code || code.length < 2 || code.length > 60000) return null;
    const kind = code[0];
    let bytes = b64UrlToBytes(code.slice(1));
    if (kind === "z") {
      if (typeof DecompressionStream === "undefined") return null;
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (kind !== "r") {
      return null;
    }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || data.v !== 1 || !Array.isArray(data.t)) return null;
    const tracks = data.t
      .filter((row) => Array.isArray(row) && YT_ID_RE.test(row[0] || ""))
      .slice(0, SHARE_MAX_TRACKS)
      .map(([id, title, channel]) => ({
        id,
        title: String(title || "Untitled").slice(0, 200),
        channel: channel ? String(channel).slice(0, 120) : null,
      }));
    if (!tracks.length) return null;
    return { label: String(data.n || "Shared playlist").slice(0, 60), tracks };
  } catch (err) {
    console.warn("Could not read shared playlist link:", err);
    return null;
  }
};

// --- Listening stats (this device only) ---
// Seconds listened per day / artist / track, kept for ~5 weeks in
// localStorage. Feeds the "Your week" card in the menu. Never sent anywhere.
const LISTENING_STATS_KEY = "raunaknama_listening_stats_v1";
const STATS_KEEP_DAYS = 35;

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const loadListeningStats = () => {
  try {
    const raw = window.localStorage.getItem(LISTENING_STATS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && parsed.days) return parsed;
  } catch (err) {
    console.warn("Could not read listening stats:", err);
  }
  return { v: 1, days: {} };
};

const persistListeningStats = (stats) => {
  try {
    window.localStorage.setItem(LISTENING_STATS_KEY, JSON.stringify(stats));
  } catch (err) {
    console.warn("Could not save listening stats:", err);
  }
};

// Real artist info fetched per track id (module-level so it survives re-renders / track switches).
const TRACK_INFO_CACHE = new Map();

const statsArtistName = (track) =>
  (track?.channel || "").replace(/\s*-\s*topic\s*$/i, "").trim() || "Unknown artist";

const addListeningSeconds = (stats, track, secs) => {
  if (!track?.id || !(secs > 0)) return stats;
  const key = dayKey();
  const day = stats.days[key] || (stats.days[key] = { s: 0, a: {}, t: {} });
  const artist = statsArtistName(track);
  day.s += secs;
  day.a[artist] = (day.a[artist] || 0) + secs;
  const entry = day.t[track.id] || (day.t[track.id] = { n: track.title || "Untitled", s: 0 });
  entry.s += secs;

  // Drop anything older than the retention window.
  const cutoff = Date.now() - STATS_KEEP_DAYS * 86400000;
  Object.keys(stats.days).forEach((k) => {
    const t = new Date(`${k}T00:00:00`).getTime();
    if (Number.isFinite(t) && t < cutoff) delete stats.days[k];
  });
  return stats;
};

const computeWeekStats = (stats) => {
  const today = new Date();
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const entry = stats.days[dayKey(d)];
    days.push({ label: d.toLocaleDateString(undefined, { weekday: "narrow" }), secs: entry?.s || 0, isToday: i === 0, entry });
  }
  const artists = {};
  const tracks = {};
  days.forEach(({ entry }) => {
    if (!entry) return;
    Object.entries(entry.a || {}).forEach(([k, v]) => { artists[k] = (artists[k] || 0) + v; });
    Object.entries(entry.t || {}).forEach(([id, v]) => {
      const cur = tracks[id] || (tracks[id] = { name: v.n, secs: 0 });
      cur.secs += v.s;
    });
  });
  const top = (obj, pick) => Object.entries(obj).sort((a, b) => pick(b[1]) - pick(a[1]))[0];
  const topArtist = top(artists, (v) => v);
  const topTrack = top(tracks, (v) => v.secs);
  return {
    days,
    totalSecs: days.reduce((n, d) => n + d.secs, 0),
    maxDay: Math.max(1, ...days.map((d) => d.secs)),
    topArtist: topArtist ? { name: topArtist[0], secs: topArtist[1] } : null,
    topTrack: topTrack ? { name: topTrack[1].name, secs: topTrack[1].secs } : null,
  };
};

const formatListenTime = (secs) => {
  const mins = Math.round(secs / 60);
  if (mins < 1) return secs > 0 ? "<1 min" : "0 min";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

const ShareIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
  </svg>
);

const ExpandIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
);

const SyncIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6h10M4 12h16M4 18h12" />
    <path d="M18 4v4M16 6h4" />
  </svg>
);

// --- Local (on-device) custom playlist storage ---
// These playlists are created by the listener and saved ONLY in this
// browser's localStorage — never sent to, or fetched from, the server.
// That means: (a) they're per-device/per-browser, and (b) clearing the
// browser's site data/cache, or using a different device, wipes them.
const LOCAL_PLAYLISTS_STORAGE_KEY = "raunaknama_local_playlists_v1";

const loadLocalPlaylists = () => {
  try {
    const raw = window.localStorage.getItem(LOCAL_PLAYLISTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("Could not read local playlists from this device's storage:", err);
    return [];
  }
};

const persistLocalPlaylists = (list) => {
  try {
    window.localStorage.setItem(LOCAL_PLAYLISTS_STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("Could not save local playlists to this device's storage:", err);
  }
};

// --- Liked / favorited tracks ---
// A simple heart-icon favorites list, saved only on this device
// (localStorage) — same pattern as the local custom playlists above.
const LOCAL_LIKES_STORAGE_KEY = "raunaknama_liked_tracks_v1";

const loadLikedTracks = () => {
  try {
    const raw = window.localStorage.getItem(LOCAL_LIKES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("Could not read liked songs from this device's storage:", err);
    return [];
  }
};

const persistLikedTracks = (list) => {
  try {
    window.localStorage.setItem(LOCAL_LIKES_STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("Could not save liked songs to this device's storage:", err);
  }
};

// --- Recently played ---
// Auto-tracked, most-recent-first list of what's actually been played this
// device, so a search result you played is still reachable after search
// results themselves disappear (e.g. after navigating away / clearing the
// search box). Saved only on this device (localStorage).
const RECENTLY_PLAYED_STORAGE_KEY = "raunaknama_recently_played_v1";
const MAX_RECENTLY_PLAYED = 30;

const loadRecentlyPlayed = () => {
  try {
    const raw = window.localStorage.getItem(RECENTLY_PLAYED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("Could not read recently played from this device's storage:", err);
    return [];
  }
};

const persistRecentlyPlayed = (list) => {
  try {
    window.localStorage.setItem(RECENTLY_PLAYED_STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("Could not save recently played to this device's storage:", err);
  }
};

// --- "Surprise me" ---
// A one-tap random pick — biased toward the same late-night / moody
// listening vibe as the app's own footer taglines, rather than a fully
// blind random query.
const SURPRISE_ME_QUERIES = [
  "lofi chill songs",
  "late night acoustic songs",
  "romantic bollywood songs",
  "sad songs playlist",
  "indie feel good songs",
  "monsoon songs",
  "old bollywood classics",
  "instrumental relaxing music",
  "soulful unplugged songs",
  "90s bollywood hits",
  "chill vibes songs",
  "rainy day songs",
  "late night drive songs",
  "soft rock love songs",
];

// --- Sleep timer ---
// Preset "stop after…" slots offered alongside the custom minutes input.
const SLEEP_TIMER_PRESETS_MIN = [15, 30, 45, 60];

// --- Resume playback position ---
// Remembers which playlist/track (or search pick) was playing and exactly
// where in it, so reopening the tab picks up close to where you left off
// instead of starting from 0:00 every time. Saved only on this device.
const PLAYBACK_STATE_STORAGE_KEY = "raunaknama_playback_state_v1";

const loadPlaybackState = () => {
  try {
    const raw = window.localStorage.getItem(PLAYBACK_STATE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn("Could not read saved playback position:", err);
    return null;
  }
};

const savePlaybackState = (state) => {
  try {
    window.localStorage.setItem(PLAYBACK_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // Private browsing / storage full — resume just won't work next time.
  }
};

// ---------- Artist card fallback ----------
// The artist card normally comes from a Wikipedia lookup (/api/artist). If that
// returns nothing (Wikipedia unreachable from the host, no article, or the
// phone keyboard changed the spelling), build a minimal card from the search
// results themselves: when the query is a name and several top results come
// from a channel with that name, it's an artist.
const ARTIST_FILLER = new Set(["song", "songs", "gana", "gaane", "hits", "hit", "best", "top", "new", "latest", "mp3", "all", "singer", "music", "official", "audio"]);
const wordTokens = (s) => String(s || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const cleanChannelName = (c) =>
  String(c || "").replace(/\s*-\s*topic$/i, "").replace(/\s*vevo$/i, "").replace(/\s*official( channel)?$/i, "").trim();
function deriveArtistFromResults(query, results) {
  const q = wordTokens(query).filter((t) => !ARTIST_FILLER.has(t));
  if (!q.length || q.length > 4 || q.join("").length < 3 || !results?.length) return null;
  const counts = new Map();
  results.slice(0, 8).forEach((r) => {
    const name = cleanChannelName(r.channel);
    const t = wordTokens(name);
    if (!t.length || t.length > q.length + 2) return;
    const ok = q.every((w, i) => t.includes(w) || (i === q.length - 1 && w.length >= 3 && t.some((x) => x.startsWith(w))));
    if (ok) counts.set(name, (counts.get(name) || 0) + 1);
  });
  let best = null;
  counts.forEach((n, name) => { if (n >= 2 && (!best || n > best.n)) best = { name, n }; });
  return best ? { name: best.name, image: null, about: "", description: "Songs from YouTube", derived: true } : null;
}

// Put a resolved direct stream into the engine's standby <audio> so it is buffered before the
// current song ends (HLS needs hls.js and can't be preloaded this way).
const preloadStandby = (id, data) => {
  if (!id || !data?.url || data.type === "hls" || data.limited) return;
  audioEngine.preload(id, data.url);
};

export default function Player({ onTrackChange, menuOpen, onCloseMenu, backgroundImageUrl, playRequest, onPlayerApi, onLikedChange, onPlaylistsChange, mode, onModeChange }) {
  // Read once, synchronously, before any state is seeded below — several
  // pieces of initial state (active playlist, track index, search pick,
  // volume) fall back to whatever was saved here so playback can resume.
  const initialPlaybackStateRef = useRef(loadPlaybackState());
  const didRestorePlaylistRef = useRef(false);
  const resumeTimeAppliedRef = useRef(false);

  const [playlist, setPlaylist] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(
    () => initialPlaybackStateRef.current?.currentIndex || 0
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const ytBlockedRef = useRef(new Set()); // track ids the YouTube-player fallback could not play (embedding disabled etc.)
  const waitTimerRef = useRef(null);      // stall detector for the normal <audio> path
  const wantsPlayRef = useRef(false); // latest play intent (read when a stream finishes resolving, so a Play tap during loading is not lost)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [playlists, setPlaylists] = useState([]);
  const [activePlaylistId, setActivePlaylistId] = useState(
    () => initialPlaybackStateRef.current?.activePlaylistId || "default"
  );

  const [shuffle, setShuffle] = useState(false);
  const [shuffleOrder, setShuffleOrder] = useState([]);

  // Autoplay: on by default so a never-ending queue of similar tracks keeps
  // playing automatically, whether the current track came from a playlist
  // or from a search pick.
  const [autoplay, setAutoplay] = useState(true);
  // Repeat-one: loops the current song natively (audio.loop), which keeps
  // working with the screen locked because no JS has to run at the loop point.
  const [repeatOne, setRepeatOne] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);

  // --- Cross-playlist search matching -------------------------------
  // trackId -> { playlistId, playlistLabel } for every track across all 7
  // radio playlists (see the background-loading effect below), plus a
  // flat list of the same data for the title-text fallback match. Refs,
  // not state — this is only ever read at ranking time, never rendered
  // directly, so there's no need to re-render when it updates (the
  // `playlistIndexVersion` bump below handles re-ranking whatever search
  // results are already on screen).
  const playlistTrackIndexRef = useRef(new Map());
  const playlistTrackListRef = useRef([]);
  const rawSearchResultsRef = useRef([]);
  const [playlistIndexVersion, setPlaylistIndexVersion] = useState(0);
  const [searchTrack, setSearchTrack] = useState(
    () => initialPlaybackStateRef.current?.activeSource === "search"
      ? initialPlaybackStateRef.current?.searchTrack || null
      : null
  );
  const [activeSource, setActiveSource] = useState(
    () => initialPlaybackStateRef.current?.activeSource || "playlist"
  );

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => {
    const saved = initialPlaybackStateRef.current?.volume;
    return typeof saved === "number" && saved >= 0 && saved <= 1 ? saved : 1;
  });
  const [showQueue, setShowQueue] = useState(false);

  // ---------- Lyrics (lrclib.net) ----------
  // Plain, unsynchronised display only — just the words for whichever
  // track is currently loaded. No timestamp tracking, no active-line
  // highlighting, no auto-scroll tied to playback position.
  const [showLyrics, setShowLyrics] = useState(false);
  // Full-screen time-synced lyrics — opens ONLY when the listener picks
  // "Synced view" inside the lyrics panel; browser full-screen never shows it.
  const [showSyncLyrics, setShowSyncLyrics] = useState(false);
  const [trackMeta, setTrackMeta] = useState({}); // id -> real artists / album fetched from YouTube Music when a track plays
  const [showFullView, setShowFullView] = useState(false); // full-page "now playing" view (components/FullPlayer.jsx)
  const [lyricsLoading, setLyricsLoading] = useState(false);
  // { available, synced: [{time, text}] | null, plain: string | null }
  const [lyricsData, setLyricsData] = useState(null);
  const lyricsRequestIdRef = useRef(0);
  // Roman / Devanagari / Urdu view of the lyrics ("orig" = exactly as fetched). Remembered on this device.
  const [scriptMode, setScriptModeState] = useState(() => {
    try { const v = window.localStorage.getItem(SCRIPT_STORAGE_KEY); return SCRIPT_MODES.some((m) => m.id === v) ? v : "orig"; } catch { return "orig"; }
  });
  // If this song's lyrics cannot be shown in the saved script (e.g. Punjabi / Tamil lyrics), they stay as
  // fetched and the toggle shows "Original" for this song; the saved choice still applies to other songs.
  const scriptAvail = useMemo(() => (scriptMode === "orig" || !lyricsData ? "ok" : scriptAvailability(lyricsData, scriptMode)), [lyricsData, scriptMode]);
  const activeScript = scriptAvail === "unavailable" ? "orig" : scriptMode;
  const setScriptMode = (m) => {
    if (m !== "orig" && m !== activeScript) {
      const a = scriptAvailability(lyricsData, m);
      const label = m === "roman" ? "Roman" : m === "dev" ? "Devanagari (\u0926\u0947\u0935\u0928\u093e\u0917\u0930\u0940)" : "Urdu (\u0627\u0631\u062f\u0648)";
      if (a === "unavailable") { pushToast(`Is song ke lyrics ${label} script me available nahi hain.`, "warning", 3500); return; }
      if (a === "same") pushToast(`Ye lyrics pehle se hi ${label} me hain.`, "success", 2800);
    }
    setScriptModeState(m);
    try { window.localStorage.setItem(SCRIPT_STORAGE_KEY, m); } catch { /* ignore */ }
  };
  const shownLyrics = useMemo(() => convertLyrics(lyricsData, activeScript), [lyricsData, activeScript]);
  const hasAnyLyrics = !!(lyricsData?.available && !lyricsData.instrumental && (lyricsData.plain || lyricsData.synced?.length));

  const [playbackError, setPlaybackError] = useState(null);

  // True only while we're actively waiting on a track's stream to resolve
  // (the yt-dlp round-trip that can take a few seconds) — drives the
  // "Loading…" indicator next to the track so listeners know it's on its
  // way instead of wondering why nothing's happening yet.
  const [isTrackLoading, setIsTrackLoading] = useState(false);

  // Toasts — small, auto-dismissing notifications for errors and network
  // status, so a failed track or a dropped connection doesn't have to take
  // over (or silently not show up in) the main player UI.
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const pushToast = useCallback((rawMessage, type = "error", durationMs = 4500) => {
    if (!rawMessage) return;
    const message = scrubBrand(rawMessage);
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, durationMs);
  }, []);
  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Offline / network-aware handling — playback over a flaky or dropped
  // connection fails in confusing ways otherwise (tracks just silently
  // won't load), so surface it plainly.
  const [isOnline, setIsOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine
  );
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      pushToast("Back online.", "success", 3000);
    };
    const handleOffline = () => {
      setIsOnline(false);
      pushToast("You're offline — playback may be interrupted.", "warning", 6000);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [pushToast]);

  // Custom playlists that any listener can create — saved only on THIS
  // device (localStorage), never on the server.
  const [customPlaylists, setCustomPlaylists] = useState(() => loadLocalPlaylists());
  const [showCreatePlaylistModal, setShowCreatePlaylistModal] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState(null); // track object currently being saved
  const [addToPlaylistFeedback, setAddToPlaylistFeedback] = useState("");
  // A playlist that arrived through a share link, waiting for "Save / Cancel".
  const [importPreview, setImportPreview] = useState(null);

  // Liked/favorited tracks — heart icon, saved only on this device.
  const [likedTracks, setLikedTracks] = useState(() => loadLikedTracks());
  const [showLikedSongs, setShowLikedSongs] = useState(false);

  // Recently played — auto-tracked, saved only on this device.
  const [recentlyPlayed, setRecentlyPlayed] = useState(() => loadRecentlyPlayed());
  const [showRecentlyPlayed, setShowRecentlyPlayed] = useState(false);

  // "Surprise me" — one-tap random track.
  const [isSurpriseLoading, setIsSurpriseLoading] = useState(false);

  // Sleep timer — "stop after N min", with presets and a custom time.
  const [sleepTimerEndAt, setSleepTimerEndAt] = useState(null);
  const [sleepTimerRemainingSecs, setSleepTimerRemainingSecs] = useState(0);
  const [showSleepTimerModal, setShowSleepTimerModal] = useState(false);
  const [customSleepMinutes, setCustomSleepMinutes] = useState("");
  const sleepTimerTimeoutRef = useRef(null);
  const sleepEndAtRef = useRef(null); // wall-clock end time; checked from audio events too, since a setTimeout alone can be delayed/skipped on a locked phone

  // Always points at the engine's ACTIVE <audio> element (primary <-> standby swap).
  const audioRef = useMemo(() => ({ get current() { return audioEngine.getActive(); } }), []);
  // ---------- Crossfade ----------
  // A second, hidden <audio> element used only to play out the *outgoing*
  // track's tail while the primary element loads and fades in the next
  // one — see the "Managed Safe Audio Loading" effect below.
  const crossfadeAudioRef = useMemo(() => ({ get current() { return audioEngine.getFade(); } }), []);
  const hasLoadedTrackRef = useRef(false); // false only before the very first track ever attaches
  const pendingFadeInRef = useRef(false); // set when the next 'playing' event should ramp volume up instead of jumping to it
  const fadeInRafRef = useRef(null);
  const fadeOutRafRef = useRef(null);
  const importFileInputRef = useRef(null); // hidden <input type="file"> for restoring a local-playlists backup
  const consecutiveFailures = useRef(0);
  const hlsRef = useRef(null);
  const handleAudioErrorRef = useRef(null); // always points at the latest handleAudioError (used by the load watchdog)
  const streamCacheRef = useRef(new Map()); // trackId -> { data: {url,type}, expires }
  wantsPlayRef.current = isPlaying;
  const loadTokenRef = useRef(0); // guards against a stale resolve landing after a newer track switch
  const autoplayHistoryRef = useRef(new Set()); // recently auto-played track ids, so the "similar songs" chain doesn't immediately repeat itself
  const retriedTrackIdsRef = useRef(new Map()); // track id -> number of forced (cache-bypassing) re-resolves already spent after playback failures
  const currentTrackIdRef = useRef(null); // latest track id, readable from async callbacks
  const preAttachedIdRef = useRef(null); // id of a track whose stream was already attached synchronously inside the "ended" event (see tryInstantAdvance) — the load effect must not redo it
  const altTriedRef = useRef(new Set()); // track ids that already got the "play another upload of this song" last-resort fallback
  const STREAM_STALL_MS = 3500; // no playable data after this long => retry via another client
  const MAX_FORCED_RETRIES = 3; // each retry asks a different extraction client / path before we give up on a track
  const backupStreamsRef = useRef({ id: null, list: [] }); // backup URLs (Piped-proxied) for the current track, tried before any forced re-resolve / skip
  const takeBackupStream = (id) => {
    const b = backupStreamsRef.current;
    if (!id || b.id !== id || !b.list.length) return null;
    return b.list.shift();
  };
  const takeForcedRetry = (id) => {
    const used = retriedTrackIdsRef.current.get(id) || 0;
    if (used >= MAX_FORCED_RETRIES) return false;
    retriedTrackIdsRef.current.set(id, used + 1);
    return true;
  };
  const playlistDataRef = useRef(new Map()); // playlistId -> { label, data } for every playlist fetched so far
  const playlistInflightRef = useRef(new Map()); // playlistId -> Promise (dedupes background + click fetches)
  const playlistsRef = useRef([]);
  playlistsRef.current = playlists;
  const playlistFailedRef = useRef(new Set()); // background fetches that failed (not retried automatically)
  // True while a user-clicked song is resolving (gate in streamClient.js).
  // Released on the audio `playing` event, or when the resolve gives up.
  const resolveGateRef = useRef(false);
  const holdResolveGate = useCallback(() => {
    if (resolveGateRef.current) return;
    resolveGateRef.current = true;
    beginPlaybackResolve();
  }, []);
  const releaseResolveGate = useCallback(() => {
    if (!resolveGateRef.current) return;
    resolveGateRef.current = false;
    endPlaybackResolve();
  }, []);
  useEffect(() => releaseResolveGate, [releaseResolveGate]);
  const prefetchedAutoplayRef = useRef(null); // { seedId, track } — the next "similar songs" autoplay pick, looked up + stream-resolved ahead of time
  const pendingBackgroundResumeRef = useRef(false); // true while we're waiting for the tab to come back to the foreground before retrying a failed resolve (see handleStreamFailure)
  const earlyAdvanceFiredRef = useRef(false); // guards the gapless early-advance (see handleTimeUpdate) from firing twice, and from double-firing alongside the real 'ended' event

  // 0. Fetch available playlists once. This runs in parallel with the
  // playlist-metadata fetch below (which now defaults to "default" instead
  // of waiting on this to resolve first) — cuts a full network round-trip
  // off the time-to-first-track.
  useEffect(() => {
    fetch(`${API_BASE}/api/playlists`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (data.playlists && data.playlists.length > 0) {
          setPlaylists(data.playlists);
          let wanted = null;
          try {
            const u = new URL(window.location.href);
            wanted = u.searchParams.get("radio");
            if (wanted) {
              u.searchParams.delete("radio");
              window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
            }
          } catch { /* ignore */ }
          const linked = wanted ? data.playlists.find((p) => p.id === wanted) : null;
          if (linked) pushToast(`Opened shared playlist "${linked.label}"`, "success");
          else if (wanted) pushToast("That shared playlist isn't available anymore.", "error");
          setActivePlaylistId((prev) =>
            linked ? linked.id : data.playlists.some((p) => p.id === prev) ? prev : data.playlists[0].id
          );
        }
      })
      .catch((err) => console.error("Playlists list fetch error:", err));
  }, []);

  // 0a. Playlist data layer.
  //   * ONLY the active playlist is fetched on load (effect 1 below).
  //   * Once it is done, the other radio playlists are loaded in the
  //     background strictly ONE AT A TIME with BG_PLAYLIST_GAP_MS between
  //     requests (never a parallel burst), purely so search can tell
  //     "this song is already in one of your playlists".
  //   * Clicking a playlist that hasn't loaded yet fetches it immediately
  //     (effect 1) — and an in-flight background fetch for the same id is
  //     reused instead of duplicated.
  //   * Background fetches wait while a clicked song is still resolving
  //     (until the <audio> element fires `playing`).
  const fetchPlaylistData = useCallback((id, label) => {
    const hit = playlistDataRef.current.get(id);
    if (hit) return Promise.resolve(hit.data);
    const pending = playlistInflightRef.current.get(id);
    if (pending) return pending;
    const p = fetch(`${API_BASE}/api/playlist?playlistId=${id}`)
      .then((res) =>
        // Read the body even on failure — the function returns a JSON
        // {error, details} payload explaining exactly why it failed.
        res.json().then((data) => {
          if (!res.ok) throw new Error(data?.details || data?.error || `HTTP ${res.status}`);
          return data;
        })
      )
      .then((data) => {
        playlistDataRef.current.set(id, { label: label || id, data });
        // Rebuild the cross-playlist search index from everything loaded so far.
        const idIndex = new Map();
        const flat = [];
        playlistDataRef.current.forEach(({ label: pl, data: d }, pid) => {
          (d?.tracks || []).forEach((t) => {
            if (!idIndex.has(t.id)) idIndex.set(t.id, { playlistId: pid, playlistLabel: pl });
            flat.push({ id: t.id, title: t.title, playlistId: pid, playlistLabel: pl });
          });
        });
        playlistTrackIndexRef.current = idIndex;
        playlistTrackListRef.current = flat;
        setPlaylistIndexVersion((v) => v + 1);
        return data;
      })
      .finally(() => playlistInflightRef.current.delete(id));
    playlistInflightRef.current.set(id, p);
    return p;
  }, []);

  useEffect(() => {
    // `loading` is true while the active playlist is still being fetched.
    if (!playlists.length || loading) return;
    let cancelled = false;
    let timer = null;

    const step = async () => {
      if (cancelled) return;
      const next = playlists.find(
        (p) => !playlistDataRef.current.has(p.id) && !playlistFailedRef.current.has(p.id)
      );
      if (!next) return; // everything loaded
      await whenPlaybackIdle(); // never compete with a song that is resolving
      if (cancelled) return;
      try {
        await fetchPlaylistData(next.id, next.label);
      } catch {
        playlistFailedRef.current.add(next.id); // don't hammer a failing playlist
      }
      if (!cancelled) timer = setTimeout(step, BG_PLAYLIST_GAP_MS);
    };

    timer = setTimeout(step, BG_PLAYLIST_GAP_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [playlists, loading, activePlaylistId, fetchPlaylistData]);

  // 0b. Safety net: never let the "Warming up the mic…" state hang forever.
  // If nothing has resolved after 20s (slow cold start, blocked network,
  // etc.) surface a real error instead of an infinite spinner.
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      setLoading((isStillLoading) => {
        if (isStillLoading) {
          setError("This is taking unusually long — the streaming server may be unreachable.");
        }
        return false;
      });
    }, 20000);
    return () => clearTimeout(timer);
  }, [loading, activePlaylistId]);

  // 1. Fetch Playlist Metadata
  useEffect(() => {
    if (!activePlaylistId) return;

    // On the very first run of this effect, if there's a saved session for
    // this exact playlist, restore its track index (and, if it was a
    // search pick playing, leave activeSource/searchTrack alone instead of
    // forcing back to "playlist") instead of always resetting to track 0.
    const saved = initialPlaybackStateRef.current;
    const isInitialRestore =
      !didRestorePlaylistRef.current && saved && saved.activePlaylistId === activePlaylistId;
    const restoredWasSearch = isInitialRestore && saved.activeSource === "search";
    didRestorePlaylistRef.current = true;

    // Local (on-device) custom playlists never touch the network — they're
    // read straight out of component state, which itself is backed by
    // this browser's localStorage.
    if (activePlaylistId.startsWith("local:")) {
      const local = customPlaylists.find((p) => p.id === activePlaylistId);
      const tracks = local ? local.tracks : [];
      setPlaylist({
        playlistTitle: local ? local.label : "Custom playlist",
        tracks,
      });
      setCurrentIndex(
        isInitialRestore ? Math.min(Math.max(saved.currentIndex || 0, 0), Math.max(tracks.length - 1, 0)) : 0
      );
      setShuffle(false);
      setShuffleOrder([]);
      if (!restoredWasSearch) setActiveSource("playlist");
      setError(
        local && local.tracks.length === 0
          ? "This playlist is empty — use the + button on any song to add it here."
          : null
      );
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    let cancelled = false;
    const activeLabel = playlistsRef.current.find((p) => p.id === activePlaylistId)?.label;
    // Fetched right away (the user opened it) — or reused from the
    // background loader / cache if it already landed.
    fetchPlaylistData(activePlaylistId, activeLabel)
      .then((data) => {
        if (cancelled) return;
        if (data.tracks && data.tracks.length > 0) {
          setPlaylist(data);
          setCurrentIndex(
            isInitialRestore
              ? Math.min(Math.max(saved.currentIndex || 0, 0), data.tracks.length - 1)
              : 0
          );
          setShuffle(false);
          setShuffleOrder([]);
          if (!restoredWasSearch) setActiveSource("playlist");
        } else {
          setError("No tracks found in playlist");
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Playlist Fetch Error:", err);
        setError(`Could not load playlist: ${err.message}`);
        setLoading(false);
        pushToast(`Could not load playlist: ${err.message}`, "error");
      });
    return () => {
      cancelled = true;
    };
  }, [activePlaylistId, customPlaylists, pushToast, fetchPlaylistData]);

  // Merges live YouTube search results with the cross-playlist index built
  // above, so a song already sitting in one of the 7 radio playlists shows
  // up first — tagged with which playlist it's from — instead of wherever
  // YouTube's search ranking happened to place it (or not at all, if it
  // didn't make YouTube's top 12 for this query).
  //
  // agar playlist me hai to sabse upar phle wo aaye, uske baad baki jaise
  // pehle aate the waise hi aayen; agar playlist me nahi hai to bilkul
  // pehle jaisa hi behavior.
  const rankSearchResults = useCallback((rawResults, query) => {
    const idIndex = playlistTrackIndexRef.current;
    const normalize = (s) => (s || "").toLowerCase().trim();

    // Definite matches: this exact video ID is a track in one of the 7
    // playlists. Tag it, but otherwise leave its position relative to the
    // other results untouched for now — the split below moves it up.
    const tagged = rawResults.map((r) => {
      const hit = idIndex.get(r.id);
      return hit ? { ...r, playlistId: hit.playlistId, playlistLabel: hit.playlistLabel } : r;
    });

    // Fallback: the song lives in a playlist but YouTube's own search
    // didn't surface that exact video in its top 12 for this query — find
    // it by title text instead so it still shows up. Capped at 5 so a
    // very generic query (e.g. a single common word) can't flood the top
    // of the list.
    const q = normalize(query);
    const seenIds = new Set(tagged.map((r) => r.id));
    const extraFromPlaylists = q
      ? playlistTrackListRef.current
          .filter((t) => !seenIds.has(t.id) && normalize(t.title).includes(q))
          .slice(0, 5)
          .map((t) => ({
            id: t.id,
            title: t.title,
            channel: "",
            duration: null,
            playlistId: t.playlistId,
            playlistLabel: t.playlistLabel,
          }))
      : [];

    const inPlaylist = tagged.filter((r) => r.playlistLabel);
    const rest = tagged.filter((r) => !r.playlistLabel);
    return [...extraFromPlaylists, ...inPlaylist, ...rest];
  }, []);

  // 2. Search Debounce
  useEffect(() => {
    if (!searchQuery.trim()) {
      rawSearchResultsRef.current = [];
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    const handle = setTimeout(() => {
      fetch(`${API_BASE}/api/search?q=${encodeURIComponent(searchQuery)}`)
        .then((res) =>
          res.json().then((data) => {
            // Same class of bug as the playlist fetch above: the server can
            // reply 200 with an empty `results` array, or reply with an
            // error status and a `details` string explaining why (e.g.
            // YouTube blocking the server IP). Previously both cases looked
            // identical to the user (empty results, nothing in the
            // console), so log the real reason when there is one.
            if (!res.ok) {
              const reason = data?.details || data?.error || `HTTP ${res.status}`;
              console.error("Search error:", reason);
              pushToast(`Search failed: ${reason}`, "error");
              return [];
            }
            return data.results || [];
          })
        )
        .then((results) => {
          rawSearchResultsRef.current = results;
          const ranked = rankSearchResults(results, searchQuery);
          setSearchResults(ranked);
          // Pre-resolve the first few results so tapping one starts right away.
          // (the Songs section warms its own top results; keep this to one so
          // the track you actually tap isn't competing with a pile of resolves)
          ranked.slice(0, 1).forEach((t) => {
            if (t?.id) setTimeout(() => warmStream(t.id), 300);
          });
        })
        .catch((err) => {
          console.error("Search error:", err);
          rawSearchResultsRef.current = [];
          setSearchResults([]);
          pushToast(
            isOnline ? "Search failed — please try again." : "You're offline — search unavailable.",
            "error"
          );
        })
        .finally(() => setIsSearching(false));
    }, 450);

    return () => clearTimeout(handle);
  }, [searchQuery, pushToast, isOnline, rankSearchResults]);

  // 2b. If the cross-playlist index finishes loading (or refreshes) after
  // results are already on screen, re-rank the results already fetched
  // instead of waiting for the next keystroke — no extra network call.
  useEffect(() => {
    if (!rawSearchResultsRef.current.length) return;
    setSearchResults(rankSearchResults(rawSearchResultsRef.current, searchQuery));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistIndexVersion]);

  const baseTrack =
    activeSource === "search" ? searchTrack : playlist?.tracks?.[currentIndex];
  // Playlist tracks only know their uploader ("T-Series"): once the song plays, the real artists /
  // album are fetched from YouTube Music (see the effect below) and shown everywhere. Same id, so
  // nothing about playback changes.
  const currentTrack = useMemo(() => {
    const m = baseTrack && trackMeta[baseTrack.id];
    if (!m) return baseTrack;
    return {
      ...baseTrack,
      uploader: baseTrack.channel,
      channel: m.channel || baseTrack.channel,
      artists: m.artists,
      album: m.album || baseTrack.album || null,
      thumbnailUrl: baseTrack.thumbnailUrl || m.thumbnailUrl || null,
      albumCover: m.thumbnailUrl || null, // the song's real cover (album art) from YouTube Music
    };
  }, [baseTrack, trackMeta]);

  useEffect(() => {
    const t = baseTrack;
    if (!t?.id || !t.title || t.isMusic || t.artists?.length) return undefined;
    const cached = TRACK_INFO_CACHE.get(t.id);
    if (cached) { setTrackMeta((prev) => (prev[t.id] ? prev : { ...prev, [t.id]: cached })); return undefined; }
    if (cached === null) return undefined; // looked up before: nothing found
    let cancelled = false;
    whenPlaybackIdle(30000) // display-only lookup: waits until the clicked song is really playing
      .then(() => new Promise((r) => setTimeout(r, showFullView ? 300 : 25000))) // singer/cover lookup: only when the full view needs it, else well after the song is playing
      .then(() => {
        if (cancelled || document.hidden) return null;
        const p = new URLSearchParams({ id: t.id, title: t.title });
        if (t.channel) p.set("channel", t.channel);
        if (t.duration) p.set("duration", String(Math.round(t.duration)));
        return fetch(`${API_BASE}/api/track-info?${p.toString()}`).then((r) => (r.ok ? r.json() : null));
      })
      .then((d) => {
        if (d === undefined || (d === null && cancelled)) return;
        const info = d?.found ? d : null;
        if (d) TRACK_INFO_CACHE.set(t.id, info);
        if (!cancelled && info) setTrackMeta((prev) => ({ ...prev, [t.id]: info }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseTrack?.id, showFullView]);

  // Keep the stream function warm (production only: a quiet serverless function otherwise costs the first
  // click a multi-second cold start). Deliberately gentle so it can never slow a song down: no ping at page
  // load, first one after 45 s, then every 4 min; only while the tab is visible and no song is resolving.
  useEffect(() => {
    if (!import.meta.env?.PROD) return undefined;
    const ping = async () => {
      if (document.hidden) return;
      await whenPlaybackIdle(1);
      if (document.hidden) return;
      fetch(`${API_BASE}/api/stream`, { method: "OPTIONS" }).catch(() => {});
    };
    const first = setTimeout(ping, 45000);
    const id = setInterval(ping, 4 * 60 * 1000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, []);


  // Resolves a track ID to { url, type: "direct"|"hls" }, via an in-memory
  // client-side cache first (instant, no network at all) and falling back
  // to /api/stream (which has its own server-side cache on top of yt-dlp).
  const resolveStream = useCallback((trackId, opts) => fetchStream(trackId, opts), []);

  // Attaches a resolved stream ({ url, type }) to the <audio> element and
  // starts playback if this is still the current load (guarded by token).
  // Deliberately NOT wrapped in useCallback: it closes over handleStreamFailure
  // (defined further below), and being redefined on every render keeps that
  // closure fresh instead of capturing a stale one. Shared by the normal
  // track-load effect and by the one-shot forced-retry path in
  // handleAudioError, so both stay in sync.
  const attachStreamAndPlay = (data, token, wantsPlay = true) => {
    const audio = audioRef.current;
    if (!audio || token !== loadTokenRef.current) return;

    // Remember the backend's backup URLs for this track. A backup being
    // attached itself (`__backup`) must not reset the remaining queue.
    if (!data.__backup) {
      backupStreamsRef.current = {
        id: currentTrackIdRef.current,
        list: Array.isArray(data.fallbacks) ? data.fallbacks.filter((f) => f?.url && f.url !== data.url) : [],
      };
    }

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const nativeHlsSupport = audio.canPlayType("application/vnd.apple.mpegurl");

    const playNow = () => {
      if (!wantsPlay) return;
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          if (err.name !== "AbortError") {
            console.warn("Playback prevented:", err.message || err);
            setIsPlaying(false);
          }
        });
      }
    };

    if (data.type === "hls" && !nativeHlsSupport) {
      if (!Hls.isSupported()) {
        setPlaybackError("This browser can't play this track's stream format.");
        return;
      }
      const hls = new Hls({
        enableWorker: true,
        maxBufferLength: 30,
        backBufferLength: 30,
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_evt, errData) => {
        if (!errData.fatal || token !== loadTokenRef.current) return;
        console.warn("HLS fatal error:", errData.type, errData.details);
        handleStreamFailure();
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (token !== loadTokenRef.current) return;
        playNow();
      });
      hls.loadSource(data.url);
      hls.attachMedia(audio);
    } else {
      // Direct/progressive URL — or a browser (Safari) that plays HLS
      // natively via the <audio> element, no hls.js needed.
      audio.src = data.url;
      audio.load();
      playNow();

      // Load watchdog: a CDN URL that never answers (throttled / dead) used to
      // leave the player on "Loading…" for a minute. If nothing is playable
      // after a few seconds, treat it like a playback error so the retry
      // ladder (different extraction client) kicks in immediately.
      if (wantsPlay) {
        setTimeout(() => {
          if (token !== loadTokenRef.current) return;
          if (typeof document !== "undefined" && document.hidden) return;
          const a = audioRef.current;
          if (!a || a.error || a.paused || a.readyState >= 3) return;
          console.warn("Stream stalled while loading — retrying with another source");
          handleAudioErrorRef.current?.();
        }, STREAM_STALL_MS);
      }
    }
  };

  // Plays `trackId` through the YouTube player (see lib/ytAudio.js). Resolves true when it started,
  // false when it could not (the caller then uses the normal server stream).
  const startYtForTrack = (trackId, token, { startAt = 0, wantsPlay = true } = {}) => {
    if (!trackId || ytBlockedRef.current.has(trackId)) return Promise.resolve(false);
    return audioEngine
      .playYt(trackId, { volume, startAt, autoplay: wantsPlay })
      .then(() => {
        if (token === loadTokenRef.current) {
          releaseResolveGate();
          setPlaybackError(null);
        }
        return true;
      })
      .catch((err) => {
        if (err?.message === "superseded") return true; // a newer track took over; nothing to fall back to
        console.warn("YouTube player fallback failed:", err?.message || err);
        ytBlockedRef.current.add(trackId);
        audioEngine.leaveYt();
        return false;
      });
  };

  // 2b. Prefetch the next track's stream info in the background — both the
  // server-side yt-dlp cache AND our client-side cache get warmed, so by
  // the time the person hits "next" there's zero yt-dlp wait and zero extra
  // network round-trip, just an immediate src swap.
  useEffect(() => {
    if (!playlist || activeSource !== "playlist" || playlist.tracks.length < 2) return;
    const nextIdx =
      shuffle && shuffleOrder.length
        ? shuffleOrder[(shuffleOrder.indexOf(currentIndex) + 1) % shuffleOrder.length]
        : (currentIndex + 1) % playlist.tracks.length;
    const nextTrack = playlist.tracks[nextIdx];
    if (!nextTrack) return;
    // A cached URL is what lets the next song start instantly even with the
    // screen locked, so make sure it really lands: retry a failed prefetch
    // once, and also warm the track after next.
    // Background prefetch: deferred one tick so the track-load effect below
    // takes the resolve gate first; then we wait until the current song is
    // actually playing and give it PREFETCH_AFTER_PLAY_MS of clear network
    // before resolving the next one (and, shortly after, the one after).
    let cancelled = false;
    let retryTimer = null;
    let nextTimer = null;
    let afterTimer = null;
    const order = shuffle && shuffleOrder.length ? shuffleOrder : null;
    const afterIdx = order
      ? order[(order.indexOf(currentIndex) + 2) % order.length]
      : (currentIndex + 2) % playlist.tracks.length;
    const afterTrack = playlist.tracks[afterIdx];
    const startTimer = setTimeout(async () => {
      await whenPlaybackIdle();
      if (cancelled) return;
      nextTimer = setTimeout(() => {
        resolveStream(nextTrack.id, { background: true })
          .then((data) => { if (!cancelled) preloadStandby(nextTrack.id, data); })
          .catch((e) => {
            if (e?.skipped) return; // limited mode: the YouTube player handles the next song, no server lookup needed
            retryTimer = setTimeout(
              () => resolveStream(nextTrack.id, { forceRefresh: true })
                .then((data) => { if (!cancelled) preloadStandby(nextTrack.id, data); })
                .catch(() => {}),
              4000
            );
          });
        if (afterTrack && afterTrack.id !== nextTrack.id && afterTrack.id !== currentTrack?.id) {
          afterTimer = setTimeout(() => resolveStream(afterTrack.id, { background: true }).catch(() => {}), 800);
        }
      }, PREFETCH_AFTER_PLAY_MS);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      if (nextTimer) clearTimeout(nextTimer);
      if (retryTimer) clearTimeout(retryTimer);
      if (afterTimer) clearTimeout(afterTimer);
    };
  }, [playlist, currentIndex, shuffle, shuffleOrder, activeSource, resolveStream]);

  // Pre-resolve the first two tracks of the active playlist so the first
  // click is a cache hit (search results are warmed where they load).
  // Background-priority: held while a clicked song is still resolving, and the
  // streamClient cache (2 h) makes repeats free.
  const listHeadKey = !loading && playlist?.tracks?.length
    ? playlist.tracks.slice(0, 2).map((t) => t.id).join(",")
    : "";
  useEffect(() => {
    if (!listHeadKey) return;
    listHeadKey.split(",").forEach((id) => warmStream(id));
  }, [listHeadKey]);

  // 3. Managed Safe Audio Loading without Race Conditions.
  // Resolves the current track to a real URL + format type, then either:
  //   - hands the URL straight to the <audio> element (direct/progressive), or
  //   - spins up hls.js to play an HLS (.m3u8) stream, which plain <audio
  //     src="..."> cannot do in Chrome/Firefox.
  useEffect(() => {
    audioEngine.leaveYt(); // new track: go back to the normal <audio> elements first
    const audio = audioRef.current;
    if (!audio) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (!currentTrack) {
      audio.removeAttribute("src");
      audio.pause();
      setIsTrackLoading(false);
      return;
    }

    const token = ++loadTokenRef.current;
    let cancelled = false;
    earlyAdvanceFiredRef.current = false;

    // The "ended" handler already swapped this track's stream in synchronously
    // (so a locked phone never has to wait on React / the network) and started
    // it — just refresh the UI state and leave the audio element alone.
    if (preAttachedIdRef.current && preAttachedIdRef.current === currentTrack.id) {
      preAttachedIdRef.current = null;
      hasLoadedTrackRef.current = true;
      setCurrentTime(0);
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      setPlaybackError(null);
      setIsTrackLoading(false);
      return () => {
        cancelled = true;
      };
    }
    preAttachedIdRef.current = null;

    // Next track already buffered in the standby element (manual Next, lock-screen Next,
    // queue advance): swap instantly instead of resolving + loading again.
    if (isPlaying && audioEngine.standbyFor(currentTrack.id)) {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      const res = audioEngine.activateStandby({ volume, loop: repeatOne });
      if (res) {
        hasLoadedTrackRef.current = true;
        setCurrentTime(0);
        setDuration(Number.isFinite(res.el.duration) ? res.el.duration : 0);
        setPlaybackError(null);
        setIsTrackLoading(false);
        res.promise?.catch((err) => {
          if (err?.name === "AbortError") return;
          console.warn("Standby play blocked:", err?.message || err);
          setIsPlaying(false);
        });
        return () => {
          cancelled = true;
        };
      }
    }

    // ---------- Crossfade out the previous track ----------
    // Only once we've already had a real track playing (never on the very
    // first load) — hand the outgoing audio's current position off to the
    // hidden secondary element, let it keep playing while it fades to
    // silence over CROSSFADE_MS, then mute the primary element so the
    // incoming track starts silent and ready to fade in once it's playing.
    // (Never while the tab is hidden/locked: a second element started from
    // the background can be blocked, leaving the page completely silent —
    // and a silent page is exactly when mobile browsers suspend it.)
    if (hasLoadedTrackRef.current && audio.src && !document.hidden) {
      const outgoing = crossfadeAudioRef.current;
      if (outgoing) {
        try {
          const startVolume = audio.volume;
          outgoing.src = audio.src;
          outgoing.currentTime = audio.currentTime;
          outgoing.volume = startVolume;
          const playPromise = outgoing.play();
          if (playPromise !== undefined) playPromise.catch(() => {});
          rampAudioVolume(outgoing, startVolume, 0, CROSSFADE_MS, fadeOutRafRef, () => {
            outgoing.pause();
            outgoing.removeAttribute("src");
          });
        } catch (err) {
          // Best-effort — worst case this track just cuts instead of fading.
        }
      }
      audio.volume = 0;
      pendingFadeInRef.current = true;
    }
    hasLoadedTrackRef.current = true;

    setCurrentTime(0);
    setDuration(0);
    setPlaybackError(null);
    setIsTrackLoading(true);

    const wantsPlay = isPlaying;

    // Pause all background fetches until this song is actually playing.
    holdResolveGate();

    // A server stream that YouTube cuts after ~850 KB (data.limited) is useless: play the song
    // through the YouTube player instead (full length, starts in ~1-2 s).
    const attachOrYt = (data) => {
      if (data?.limited && !ytBlockedRef.current.has(currentTrack.id)) {
        startYtForTrack(currentTrack.id, token, { wantsPlay: wantsPlayRef.current }).then((ok) => {
          if (cancelled || token !== loadTokenRef.current) return;
          if (!ok) attachStreamAndPlay(data, token, wantsPlayRef.current);
        });
        return;
      }
      attachStreamAndPlay(data, token, wantsPlayRef.current);
    };

    const runResolve = () => {
    // A recently played song may still be in the temporary on-device cache → instant, no network.
    trackCache.getUrl(currentTrack.id)
      .then((cachedUrl) => (cachedUrl
        ? { url: cachedUrl, type: "direct", __backup: true, __cached: true }
        : resolveStream(currentTrack.id)))
      .then((data) => {
        if (cancelled || token !== loadTokenRef.current) return;
        // Keep "Loading…" visible until the audio really has data (canplay / playing event).
        attachOrYt(data);
      })
      .catch((err) => {
        if (cancelled || token !== loadTokenRef.current) return;
        console.warn("Stream resolve error:", err.message, err.details ? `— ${err.details}` : "");

        // Cookie/bot-check failures are a config problem, not a bad resolve
        // — every track will fail identically, so retrying wastes a call.
        // For anything else, try once more with a forced, cache-bypassing
        // re-resolve (backend uses an alternate extraction client) before
        // giving up on this track.
        const isCookieError = err.details && /cookie|sign in to confirm/i.test(err.details);
        const trackId = currentTrack.id;
        if (!isCookieError && trackId && takeForcedRetry(trackId)) {
          resolveStream(trackId, { forceRefresh: true })
            .then((data) => {
              if (cancelled || token !== loadTokenRef.current) return;
              attachOrYt(data);
            })
            .catch((err2) => {
              if (cancelled || token !== loadTokenRef.current) return;
              console.warn("Stream re-resolve also failed:", err2.message);
              releaseResolveGate();
              setIsTrackLoading(false);
              handleStreamFailure(err2.details || err2.message);
            });
          return;
        }

        releaseResolveGate();
        setIsTrackLoading(false);
        handleStreamFailure(err.details || err.message);
      });
    };

    // After the first "limited" answer from the server, skip the server entirely and go straight
    // to the YouTube player (fast start). If that fails, the normal path below takes over.
    if (isLimitedMode() && !ytBlockedRef.current.has(currentTrack.id)) {
      startYtForTrack(currentTrack.id, token, { wantsPlay: wantsPlayRef.current }).then((ok) => {
        if (cancelled || token !== loadTokenRef.current) return;
        if (!ok) runResolve();
      });
    } else {
      runResolve();
    }

    return () => {
      cancelled = true;
    };
  }, [currentTrack?.id, activeSource, resolveStream]);

  // Tear down any live hls.js instance when the component unmounts.
  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, []);

  // Cancel any in-flight crossfade volume ramps on unmount, and stop the
  // hidden crossfade element so it doesn't keep playing into the void.
  useEffect(() => {
    return () => {
      if (fadeInRafRef.current) cancelAnimationFrame(fadeInRafRef.current);
      if (fadeOutRafRef.current) cancelAnimationFrame(fadeOutRafRef.current);
      const outgoing = crossfadeAudioRef.current;
      if (outgoing) {
        outgoing.pause();
        outgoing.removeAttribute("src");
      }
    };
  }, []);

  // Keep the <audio> element's actual volume in sync with the volume state
  // — covers the initial mount (including a resumed/saved volume) and
  // volume changes made via the keyboard shortcuts below.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // ---------- Resume playback position: periodic + event-based saving ----------
  // Snapshots exactly what's playing and where, every few seconds and at
  // key moments (tab hidden, page unload, track/playlist change), so the
  // next visit can pick back up close to this spot.
  useEffect(() => {
    if (!currentTrack) return;

    const persist = () => {
      savePlaybackState({
        activePlaylistId,
        currentIndex,
        activeSource,
        searchTrack: activeSource === "search" ? searchTrack : null,
        trackId: currentTrack.id,
        currentTime: audioRef.current?.currentTime || 0,
        volume,
      });
    };

    const intervalId = setInterval(persist, 5000);
    document.addEventListener("visibilitychange", persist);
    window.addEventListener("pagehide", persist);
    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", persist);
      window.removeEventListener("pagehide", persist);
      persist();
    };
  }, [currentTrack?.id, activePlaylistId, currentIndex, activeSource, searchTrack, volume]);

  // ---------- Media Session (lock screen / notification / headset) ----------
  currentTrackIdRef.current = currentTrack?.id || null;
  useMediaSession({
    track: currentTrack
      ? {
          id: currentTrack.id,
          title: currentTrack.title,
          artist:
            activeSource === "search"
              ? currentTrack.channel || "RaunakNama"
              : playlist?.playlistTitle || "RaunakNama",
          artworkUrl: backgroundImageUrl || "/icon-512.png",
        }
      : null,
    isPlaying,
    actions: { onNext: () => handleNext(), onPrevious: () => handlePrev() },
  });

  // ---------- Audio engine events (both <audio> elements) ----------
  // Only the ACTIVE element's events drive the UI; the retired/standby one is ignored, so the
  // pause + ended of the old track can't flicker the UI or the lock-screen card.
  const engineHandlersRef = useRef({});
  engineHandlersRef.current = {
    playing: () => handleAudioPlaying(),
    ended: () => handleTrackEnded(),
    timeUpdate: () => handleTimeUpdate(),
    loadedMetadata: () => handleLoadedMetadata(),
    error: () => handleAudioError(),
  };
  useEffect(() => {
    audioEngine.installUnlock();
    trackCache.init();
    return audioEngine.subscribe((type, e, isActive) => {
      const h = engineHandlersRef.current;
      if (!isActive) {
        // A standby stream that failed to buffer is dropped; the normal path takes over.
        if (type === "error" && audioEngine.standbyId()) audioEngine.clearStandby();
        return;
      }
      switch (type) {
        case "play": setIsPlaying(true); break;
        case "waiting":
          setIsTrackLoading(true);
          // The normal stream stalled (e.g. YouTube cut it off): after a few seconds hand over to
          // the YouTube player from the same position instead of waiting forever.
          clearTimeout(waitTimerRef.current);
          if (!audioEngine.isYt()) {
            waitTimerRef.current = setTimeout(() => {
              const a = audioEngine.getActive();
              if (!audioEngine.isYt() && a && a.readyState < 3 && !a.ended && !document.hidden) h.error();
            }, 7000);
          }
          break;
        case "canplay": clearTimeout(waitTimerRef.current); setIsTrackLoading(false); break;
        case "playing": clearTimeout(waitTimerRef.current); h.playing(); break;
        case "pause": if (!e.target.ended) setIsPlaying(false); break;
        case "ended": h.ended(); break;
        case "timeupdate": h.timeUpdate(); break;
        case "loadedmetadata": h.loadedMetadata(); break;
        case "durationchange":
          if (Number.isFinite(e.target.duration)) setDuration(e.target.duration);
          break;
        case "error": h.error(); break;
        default:
      }
    });
  }, []);
  useEffect(
    () => () => {
      audioEngine.stopKeepAlive();
    },
    []
  );

  // ---------- Listening stats ----------
  // While audio is actually playing, add the wall-clock time to today's
  // totals (per artist + per track). Wall-clock deltas (not tick counts) keep
  // it accurate even when the browser throttles timers in a background tab.
  const statsRef = useRef(null);
  if (statsRef.current === null) statsRef.current = loadListeningStats();
  const statsTrackRef = useRef(null);
  statsTrackRef.current = currentTrack;
  useEffect(() => {
    if (!isPlaying) return undefined;
    const trk = statsTrackRef.current;
    if (!trk?.id) return undefined;
    let last = Date.now();
    const flush = () => {
      const now = Date.now();
      const secs = Math.min((now - last) / 1000, 120);
      last = now;
      const a = audioRef.current;
      if (secs > 0 && !(a && a.paused)) {
        statsRef.current = addListeningSeconds(statsRef.current, trk, secs);
      }
    };
    const timer = setInterval(() => { flush(); persistListeningStats(statsRef.current); }, 10000);
    return () => {
      clearInterval(timer);
      flush();
      persistListeningStats(statsRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, currentTrack?.id]);

  // ---------- Shared playlist link (?pl=...) ----------
  useEffect(() => {
    let cancelled = false;
    const code = new URLSearchParams(window.location.search).get("pl");
    if (!code) return undefined;
    decodePlaylistShare(code).then((pl) => {
      if (cancelled) return;
      if (pl) setImportPreview(pl);
      else pushToast("This playlist link looks broken or incomplete.", "error", 6000);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Keyboard shortcuts ----------
  // Space: play/pause · ←/→: seek 5s · ↑/↓: volume · N/P: next/prev track.
  // Ignored while typing in any text field, and while modifier keys are
  // held (so browser/OS shortcuts still work normally).
  useEffect(() => {
    const onKeyDown = (e) => {
      const active = document.activeElement;
      const tag = active?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || active?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const audio = audioRef.current;
      switch (e.key) {
        case " ":
        case "Spacebar":
          e.preventDefault();
          togglePlayPause();
          break;
        case "ArrowRight":
          if (audio) audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 5);
          break;
        case "ArrowLeft":
          if (audio) audio.currentTime = Math.max(0, audio.currentTime - 5);
          break;
        case "ArrowUp": {
          e.preventDefault();
          setVolume((v) => Math.min(1, Math.round((v + 0.05) * 100) / 100));
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          setVolume((v) => Math.max(0, Math.round((v - 0.05) * 100) / 100));
          break;
        }
        case "n":
        case "N":
          handleNext();
          break;
        case "p":
        case "P":
          handlePrev();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Purely presentational: let the parent know the playing track changed
  // (new song, next/prev, autoplay chain, playlist switch, search pick)
  // so it can swap the full-screen background photo. Doesn't read or
  // affect any playback state.
  useEffect(() => {
    if (currentTrack?.id && typeof onTrackChange === "function") {
      onTrackChange(currentTrack.id);
    }
  }, [currentTrack?.id, onTrackChange]);

  // ---------- Recently played ----------
  // Auto-tracks whatever is currently loaded (playlist track or search
  // pick) into a most-recent-first, deduped, capped list on this device —
  // so a track played from search is still reachable after the search
  // results themselves are gone.
  useEffect(() => {
    if (!currentTrack?.id) return;
    setRecentlyPlayed((prev) => {
      const entry = {
        id: currentTrack.id,
        title: currentTrack.title,
        channel: currentTrack.channel || null,
        playedAt: Date.now(),
      };
      const next = [entry, ...prev.filter((t) => t.id !== currentTrack.id)].slice(
        0,
        MAX_RECENTLY_PLAYED
      );
      persistRecentlyPlayed(next);
      return next;
    });
  }, [currentTrack?.id]);

  // ---------- Lyrics (lrclib.net) ----------
  // Fetches synced/plain lyrics for whatever track is currently loaded, via
  // /api/lyrics (which itself talks to lrclib.net). Re-fires whenever the
  // track changes; a monotonically increasing request id guards against a
  // slow, stale response from a previous track overwriting the lyrics for
  // the one now playing (e.g. rapid next/prev taps).
  useEffect(() => {
    if (!currentTrack?.id || !currentTrack?.title) {
      setLyricsData(null);
      setLyricsLoading(false);
      return;
    }

    const requestId = ++lyricsRequestIdRef.current;
    setLyricsLoading(true);
    setLyricsData(null);

    const params = new URLSearchParams({ track: currentTrack.title, id: currentTrack.id });
    if (currentTrack.channel) params.set("artist", currentTrack.channel);
    if (currentTrack.duration) params.set("duration", String(Math.round(currentTrack.duration)));

    // Lyrics are secondary: let the song's own stream resolve take the network
    // first (gate in streamClient.js), but never wait more than 2.5 s for it.
    whenPlaybackIdle(2500)
      .then(() => {
        if (lyricsRequestIdRef.current !== requestId) return null; // already superseded
        return fetch(`${API_BASE}/api/lyrics?${params.toString()}`).then((res) => res.json());
      })
      .then((data) => {
        if (lyricsRequestIdRef.current !== requestId) return; // stale — a newer track has since loaded
        if (!data || !data.available) {
          setLyricsData({ available: false });
          return;
        }
        setLyricsData({
          available: true,
          synced: data.synced ? parseLRC(data.synced) : [],
          plain: data.plain || null,
          instrumental: !!data.instrumental,
          source: data.source || null,
        });
      })
      .catch((err) => {
        if (lyricsRequestIdRef.current !== requestId) return;
        console.error("Lyrics fetch error:", err);
        setLyricsData({ available: false });
      })
      .finally(() => {
        if (lyricsRequestIdRef.current === requestId) setLyricsLoading(false);
      });
  }, [currentTrack?.id, currentTrack?.title, currentTrack?.channel, currentTrack?.duration]);

  // ---------- Sleep timer ----------
  // Ticks the visible countdown once a second while a timer is running.
  useEffect(() => {
    if (!sleepTimerEndAt) return;
    const tick = () => {
      setSleepTimerRemainingSecs(Math.max(0, Math.round((sleepTimerEndAt - Date.now()) / 1000)));
    };
    tick();
    const intervalId = setInterval(tick, 1000);
    return () => clearInterval(intervalId);
  }, [sleepTimerEndAt]);

  // Never let a pending sleep timer keep firing after the component unmounts.
  useEffect(() => {
    return () => {
      if (sleepTimerTimeoutRef.current) clearTimeout(sleepTimerTimeoutRef.current);
    };
  }, []);

  // 4. Playback Controls
  const handleNext = () => {
    if (!playlist) return;
    triggerHaptic();
    setActiveSource("playlist");
    if (shuffle && shuffleOrder.length) {
      const pos = shuffleOrder.indexOf(currentIndex);
      const nextPos = (pos + 1) % shuffleOrder.length;
      setCurrentIndex(shuffleOrder[nextPos]);
    } else {
      setCurrentIndex((prev) => (prev + 1) % playlist.tracks.length);
    }
  };

  const handlePrev = () => {
    if (!playlist) return;
    triggerHaptic();
    setActiveSource("playlist");
    if (shuffle && shuffleOrder.length) {
      const pos = shuffleOrder.indexOf(currentIndex);
      const prevPos = (pos - 1 + shuffleOrder.length) % shuffleOrder.length;
      setCurrentIndex(shuffleOrder[prevPos]);
    } else {
      setCurrentIndex((prev) => (prev - 1 + playlist.tracks.length) % playlist.tracks.length);
    }
  };

  const togglePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;
    triggerHaptic();

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false); // also covers "paused while still loading" (no pause event fires then)
    } else if (currentTrack && (!audio.getAttribute("src") || audio.readyState === 0 && !audio.error && isTrackLoading)) {
      // The song is still being fetched (no source yet): remember the intent + show loading.
      // The stream attaches itself and starts playing as soon as it resolves.
      setIsPlaying(true);
      setIsTrackLoading(true);
      if (!isTrackLoading) {
        // Nothing is in flight (an earlier attempt ended without a stream) → start a fresh load.
        const token = ++loadTokenRef.current;
        holdResolveGate();
        resolveStream(currentTrack.id, { forceRefresh: true })
          .then((data) => {
            if (token !== loadTokenRef.current) return;
            attachStreamAndPlay(data, token, true);
          })
          .catch((err) => {
            if (token !== loadTokenRef.current) return;
            releaseResolveGate();
            setIsTrackLoading(false);
            handleStreamFailure(err.details || err.message);
          });
      }
    } else {
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => setIsPlaying(true))
          .catch((err) => {
            if (err.name !== "AbortError") {
              console.warn("Play error:", err.message || err);
            }
            setIsPlaying(false);
          });
      }
    }
  };

  // Backoff delays (ms) used by handleStreamFailure's hidden-tab retry loop
  // below. Mobile browsers grant a tab with an actively-playing MediaSession
  // a limited amount of background execution time (that's precisely why
  // audio keeps playing after the screen locks) — a failed fetch in that
  // window is almost always just bad timing, not a dead backend, and a
  // short retry loop recovers the large majority of these on its own,
  // without the listener ever noticing or seeing an error. ~89s of total
  // retrying covers the sort of brief background-fetch stalls this causes.
  const HIDDEN_RETRY_BACKOFF_MS = [1500, 4000, 8000, 15000, 30000, 30000];

  const handleStreamFailure = (message, hiddenRetryAttempt = 0) => {
    // Mobile browsers (Android Chrome especially) heavily throttle network
    // requests and timers for a tab once it's backgrounded — which is
    // exactly what happens when the screen gets locked during background
    // audio playback. When that happens, the "next track" resolve fetch
    // (fired from the <audio> "ended" event) can fail or time out for no
    // real backend reason. Previously that got treated as a genuine
    // failure: it counted toward consecutiveFailures, showed a scary
    // "backend is likely blocked or down" toast, and tried to auto-skip via
    // setTimeout — which is *itself* throttled while hidden, so skips piled
    // up and stalled out. That matches the reported bug: playback died
    // after the first track while locked, and only recovered once the
    // phone was unlocked and the site was back in the foreground.
    //
    // Fix, two layers, both silent (no error toast, no consecutiveFailures
    // bump) while the tab is hidden:
    //   1. First, retry the same track with backoff a handful of times —
    //      this is what lets the queue keep auto-advancing while the phone
    //      stays locked, matching what background playback should feel
    //      like, since most throttled fetches succeed within this window.
    //   2. Only if every backoff attempt also fails (persistent bad network,
    //      or the OS/browser suspended the tab harder than usual) do we give
    //      up retrying blind and instead wait for the tab to actually become
    //      visible again before trying once more.
    if (typeof document !== "undefined" && document.hidden) {
      const trackId = currentTrack?.id;
      if (!trackId) return;

      if (hiddenRetryAttempt < HIDDEN_RETRY_BACKOFF_MS.length) {
        setTimeout(() => {
          // The track may have changed, or the tab may have come back to
          // the foreground, while we were waiting — either way just let
          // the normal load effect / a future failure handle it instead of
          // stepping on a newer load.
          if (currentTrack?.id !== trackId) return;
          const token = ++loadTokenRef.current;
          resolveStream(trackId, { forceRefresh: true })
            .then((data) => {
              if (token !== loadTokenRef.current) return;
              attachStreamAndPlay(data, token, true);
            })
            .catch((err) => {
              if (token !== loadTokenRef.current) return;
              handleStreamFailure(err.details || err.message, hiddenRetryAttempt + 1);
            });
        }, HIDDEN_RETRY_BACKOFF_MS[hiddenRetryAttempt]);
        return;
      }

      if (!pendingBackgroundResumeRef.current) {
        pendingBackgroundResumeRef.current = true;
        const onVisible = () => {
          if (document.hidden) return;
          document.removeEventListener("visibilitychange", onVisible);
          pendingBackgroundResumeRef.current = false;

          const resumeTrackId = currentTrack?.id;
          if (!resumeTrackId) return;
          const token = ++loadTokenRef.current;
          setIsTrackLoading(true);
          resolveStream(resumeTrackId, { forceRefresh: true })
            .then((data) => {
              if (token !== loadTokenRef.current) return;
              setIsTrackLoading(false);
              attachStreamAndPlay(data, token, true);
            })
            .catch((err) => {
              if (token !== loadTokenRef.current) return;
              setIsTrackLoading(false);
              console.warn(
                "Resume-on-foreground retry failed:",
                err.message,
                err.details ? `— ${err.details}` : ""
              );
              handleStreamFailure(err.details || err.message);
            });
        };
        document.addEventListener("visibilitychange", onVisible);
      }
      return;
    }

    setIsPlaying(false);

    // Offline is almost certainly the real reason a stream just failed to
    // resolve — say so plainly instead of a generic/misleading message.
    if (!isOnline) {
      const offlineMsg = "You're offline — playback paused.";
      setPlaybackError(offlineMsg);
      pushToast(offlineMsg, "warning");
      return;
    }

    // "Sign in to confirm you're not a bot" / cookie-required failures are a
    // config problem, not a bad track — every track will fail the same way,
    // so skipping through the whole playlist just burns yt-dlp calls and
    // buries the real reason under "skipping…" noise. Surface it plainly
    // and stop, rather than auto-advancing.
    if (message && /cookie|sign in to confirm/i.test(message)) {
      setPlaybackError(message);
      pushToast(message, "error", 6500);
      return;
    }

    // Last resort before giving up: the exact upload may be region/age/PO-token
    // gated, but another upload of the same song (official audio, lyric video,
    // "Topic" channel…) almost always plays. Look one up and play that instead
    // of showing an error and skipping a song the listener asked for.
    const failedTrack = currentTrack;
    if (failedTrack?.id && !altTriedRef.current.has(failedTrack.id)) {
      altTriedRef.current.add(failedTrack.id);
      const token = ++loadTokenRef.current;
      setIsTrackLoading(true);
      setPlaybackError(null);
      playAlternateVersion(failedTrack, token)
        .then((ok) => {
          if (token !== loadTokenRef.current) return;
          if (!ok) {
            setIsTrackLoading(false);
            skipFailedTrack(message);
          }
        })
        .catch(() => {
          if (token !== loadTokenRef.current) return;
          setIsTrackLoading(false);
          skipFailedTrack(message);
        });
      return;
    }

    skipFailedTrack(message);
  };

  // Searches for another upload of the same song and plays it. Resolves true
  // when a replacement stream was attached, false when nothing usable exists.
  const playAlternateVersion = async (track, token) => {
    const base = `${track.title || ""} ${track.channel || track.artist || track.subtitle || ""}`
      .replace(/\(.*?\)|\[.*?\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!base) return false;
    const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(`${base} audio`)}`);
    if (!res.ok) return false;
    const data = await res.json();
    const want = Number(track.duration) || 0;
    const candidates = (data.results || []).filter((t) => {
      if (!t?.id || t.id === track.id) return false;
      if (altTriedRef.current.has(t.id)) return false;
      const d = Number(t.duration) || 0;
      if (want && d) return d >= want * 0.75 && d <= want * 1.35;
      return !d || d <= 10 * 60;
    });
    for (const cand of candidates.slice(0, 3)) {
      if (token !== loadTokenRef.current) return true; // user moved on; nothing more to do
      try {
        const stream = await resolveStream(cand.id);
        if (token !== loadTokenRef.current) return true;
        setIsTrackLoading(false);
        attachStreamAndPlay(stream, token, true);
        return true;
      } catch {
        // try the next candidate
      }
    }
    return false;
  };

  const skipFailedTrack = (message) => {
    releaseResolveGate();
    consecutiveFailures.current += 1;
    if (consecutiveFailures.current > 5) {
      const stopMsg =
        "Several tracks in a row failed to play. The streaming service looks unavailable right now.";
      setPlaybackError(stopMsg);
      pushToast(stopMsg, "error", 6500);
      return;
    }

    const skipMsg = message || "Couldn't play this track — skipping…";
    setPlaybackError(skipMsg);
    pushToast(skipMsg, "error");
    if (activeSource === "playlist" && playlist && playlist.tracks.length > 1) {
      setTimeout(() => handleNext(), 1200);
    }
  };

  const handleAudioError = () => {
    const mediaError = audioRef.current?.error;
    console.warn("Audio element error:", mediaError?.message || mediaError);

    // A track's stream can resolve successfully server-side but still fail
    // to actually play in the browser — a throttled/expired CDN URL, or a
    // format this browser rejects (surfaces as MEDIA_ELEMENT_ERROR: Format
    // error / "no supported source were found"). Before skipping, try
    // exactly once more: bypass every cache and ask the backend to
    // re-resolve using a different extraction client. That alone recovers
    // a large share of these failures without bothering the listener.
    const trackId = currentTrack?.id;
    if (trackId && audioRef.current?.src?.startsWith("blob:")) trackCache.remove(trackId);

    // The YouTube player itself failed (e.g. embedding disabled for this video): use the server path.
    if (audioEngine.isYt()) {
      audioEngine.leaveYt();
      if (trackId) ytBlockedRef.current.add(trackId);
    } else if (trackId && !ytBlockedRef.current.has(trackId)) {
      // The server stream broke (usually YouTube cutting it after ~850 KB): continue the same
      // song, from the same position, through the YouTube player.
      const startAt = audioRef.current?.currentTime || 0;
      const token = ++loadTokenRef.current;
      setIsTrackLoading(true);
      startYtForTrack(trackId, token, { startAt, wantsPlay: wantsPlayRef.current || isPlaying }).then((ok) => {
        if (token !== loadTokenRef.current) return;
        if (!ok) handleAudioErrorRef.current?.(); // now blocked -> normal retry ladder
      });
      return;
    }

    // Step 1 — a 403 / dead URL (usually YouTube's IP-binding): switch to the
    // backup stream the backend sent along (Piped-proxied) without skipping.
    const backup = takeBackupStream(trackId);
    if (backup) {
      console.warn("Primary stream failed — switching to backup stream:", backup.client || "backup");
      const token = ++loadTokenRef.current;
      setIsTrackLoading(true);
      attachStreamAndPlay({ type: "direct", ...backup, __backup: true }, token, true);
      return;
    }

    // Step 2 — re-fetch a fresh stream with ?fallback=true (see streamClient).
    if (trackId && takeForcedRetry(trackId)) {
      const token = ++loadTokenRef.current;
      setIsTrackLoading(true);
      // Direct url and proxy backup both failed: go straight to yt-dlp
      // (cookies on the server) and hand its url to <audio>.
      resolveStream(trackId, { forceRefresh: true, ytdlp: true })
        .then((data) => {
          if (token !== loadTokenRef.current) return;
          setIsTrackLoading(false);
          attachStreamAndPlay(data, token, true);
        })
        .catch((err) => {
          if (token !== loadTokenRef.current) return;
          setIsTrackLoading(false);
          // Bug: this used to log only err.message and always hand
          // handleStreamFailure a hardcoded generic string, discarding
          // err.details entirely. That meant the *real* reason (a timed-out
          // yt-dlp call, "Sign in to confirm you're not a bot", etc.) never
          // reached the console or the UI — every failure looked identical
          // and got silently skipped, including config problems (missing/
          // expired cookies) that will fail on every single track and
          // should stop-and-report instead of skip-and-hide. Mirror the
          // same details-preserving, cookie-aware handling the primary
          // resolveStream().catch() above already does.
          console.warn(
            "Forced re-resolve after playback failure also failed:",
            err.message,
            err.details ? `— ${err.details}` : ""
          );
          handleStreamFailure(err.details || err.message);
        });
      return;
    }

    handleStreamFailure();
  };

  handleAudioErrorRef.current = handleAudioError;

  const handleAudioPlaying = () => {
    releaseResolveGate(); // background prefetch / playlist loading may resume now
    audioEngine.stopKeepAlive();
    ensureStandbyRef.current?.();
    consecutiveFailures.current = 0;
    if (currentTrack?.id) {
      retriedTrackIdsRef.current.delete(currentTrack.id);
      altTriedRef.current.delete(currentTrack.id);
    }
    setIsTrackLoading(false);
    setPlaybackError(null);
    setIsPlaying(true);

    // After the song has been playing for a bit, keep a temporary copy on the device so
    // "Previous"/replay is instant. Old copies are auto-deleted (see lib/trackCache.js).
    {
      const a = audioRef.current;
      const id = currentTrack?.id;
      const src = a?.src;
      if (id && src && !src.startsWith("blob:")) {
        // Only copy a song once the player has ALREADY buffered all of it (proves the stream
        // is complete and not cut off), so this never adds load to a struggling server.
        let tries = 0;
        const check = () => {
          const cur = audioRef.current;
          if (currentTrackIdRef.current !== id || !cur || cur.src !== src) return;
          const d = cur.duration;
          const buf = cur.buffered;
          const full = Number.isFinite(d) && d > 0 && buf.length > 0 && buf.end(buf.length - 1) >= d - 1.5 && buf.start(0) <= 1;
          if (full) { trackCache.save(id, src); return; }
          if (++tries < 40) setTimeout(check, 6000);
        };
        setTimeout(check, 8000);
      }
    }

    // If this "playing" is the start of a freshly-switched track (see the
    // crossfade-out kickoff in the loading effect), ramp its volume up from
    // silent instead of jumping straight to full — that's the "fade in"
    // half of the crossfade.
    if (pendingFadeInRef.current) {
      pendingFadeInRef.current = false;
      const audio = audioRef.current;
      if (audio) {
        rampAudioVolume(audio, 0, volume, FADE_IN_MS, fadeInRafRef);
      }
    }
  };

  const toggleShuffle = () => {
    setShuffle((prev) => {
      const next = !prev;
      if (next && playlist) {
        setShuffleOrder(shuffledIndices(playlist.tracks.length));
      }
      return next;
    });
  };

  // Autoplay: when a track that isn't part of a playlist (i.e. one played
  // via search) finishes, look up tracks similar to it (same channel/title
  // via the existing search endpoint) and keep the chain going forever,
  // never repeating a recently-played pick. Candidates are biased toward
  // actual songs (query includes "song") and capped at 10 minutes so we
  // don't autoplay into full mixes, podcasts, or long videos.
  const MAX_AUTOPLAY_DURATION_SECS = 10 * 60;

  // Looks up a track "similar to" the given seed (same channel/title, biased
  // toward actual songs, capped at MAX_AUTOPLAY_DURATION_SECS), skipping
  // anything already played recently in this chain. Shared by the prefetch
  // effect below and the fallback path in playNextAutoplayTrack, so both
  // pick candidates the exact same way.
  const fetchAutoplayCandidate = useCallback((seed) => {
    if (!seed) return Promise.resolve(null);
    const q = `${seed.channel || seed.title} song`;
    return fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q)}`)
      .then((res) => res.json())
      .then((data) => {
        const candidates = (data.results || []).filter(
          (t) =>
            t.id !== seed.id &&
            !autoplayHistoryRef.current.has(t.id) &&
            t.duration &&
            t.duration <= MAX_AUTOPLAY_DURATION_SECS
        );
        return candidates[Math.floor(Math.random() * candidates.length)] || null;
      });
  }, []);

  const playNextAutoplayTrack = () => {
    const seed = currentTrack;
    if (!seed) {
      setIsPlaying(false);
      return;
    }

    // Best case: we already looked up AND stream-resolved the next pick
    // while this seed track was still playing (see the prefetch effect
    // below) — hand off to it immediately, no search call, no yt-dlp wait.
    const prefetched = prefetchedAutoplayRef.current;
    if (prefetched && prefetched.seedId === seed.id && prefetched.track) {
      const next = prefetched.track;
      prefetchedAutoplayRef.current = null;
      autoplayHistoryRef.current.add(next.id);
      if (autoplayHistoryRef.current.size > 40) {
        autoplayHistoryRef.current.clear();
      }
      setSearchTrack(next);
      setActiveSource("search");
      setIsPlaying(true);
      return;
    }

    // Fallback (prefetch hadn't landed yet, or got cleared) — same lookup,
    // done on demand like before.
    fetchAutoplayCandidate(seed)
      .then((next) => {
        if (!next) {
          setIsPlaying(false);
          return;
        }
        autoplayHistoryRef.current.add(next.id);
        if (autoplayHistoryRef.current.size > 40) {
          autoplayHistoryRef.current.clear();
        }
        setSearchTrack(next);
        setActiveSource("search");
        setIsPlaying(true);
      })
      .catch((err) => {
        console.error("Autoplay similar-track fetch error:", err);
        setIsPlaying(false);
      });
  };

  // Prefetch the next AUTOPLAY ("similar songs") pick too — same idea as
  // the playlist-queue prefetch further up: while the current search-
  // sourced track plays, quietly look up the next candidate AND resolve its
  // stream URL in the background, so when this track ends the chain hands
  // off instantly instead of waiting on a fresh search + yt-dlp round-trip.
  useEffect(() => {
    if (activeSource !== "search" || !autoplay) return;
    const seed = currentTrack;
    if (!seed) return;

    let cancelled = false;
    fetchAutoplayCandidate(seed)
      .then((next) => {
        if (cancelled || !next) return;
        prefetchedAutoplayRef.current = { seedId: seed.id, track: next };
        resolveStream(next.id, { background: true })
          .then((data) => { if (!cancelled) preloadStandby(next.id, data); })
          .catch(() => {});
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [currentTrack?.id, activeSource, autoplay, fetchAutoplayCandidate, resolveStream]);

  // Fired when the <audio> element's "ended" event fires. Routes to the
  // right "next track" behavior depending on where the current track came
  // from, but only when autoplay is switched on.
  //
  // Note: the browser fires "pause" right before "ended", which flips
  // isPlaying to false via the existing onPause handler. For the playlist
  // branch we re-assert isPlaying(true) after advancing so the newly loaded
  // track actually starts playing instead of loading silently.
  //
  // In the normal case this never actually runs the advance logic below —
  // handleTimeUpdate's gapless early-advance (see its comment) already
  // switched to the next track a couple seconds before natural end, which
  // means audio.src (and therefore the whole "current track") already
  // changed, so this "ended" event belongs to an abandoned load and Chrome
  // won't even fire it. This stays as a safety net for the rare case
  // duration was unknown/Infinity (e.g. a live/HLS edge case) so early
  // advance never got a chance to fire.
  // Works out which track comes next (same rules the buttons / autoplay use)
  // and, if its stream URL is already cached, attaches + starts it RIGHT NOW,
  // synchronously, inside the "ended" event. A locked phone gives the page
  // almost no time after audio stops — waiting for a React render and a
  // network call is exactly where "next song never plays" came from.
  const getNextTrack = () => {
    if (activeSource === "search") {
      const pre = prefetchedAutoplayRef.current;
      return pre && pre.seedId === currentTrack?.id ? pre.track : null;
    }
    if (playlist && playlist.tracks.length > 1) {
      const nextIdx =
        shuffle && shuffleOrder.length
          ? shuffleOrder[(shuffleOrder.indexOf(currentIndex) + 1) % shuffleOrder.length]
          : (currentIndex + 1) % playlist.tracks.length;
      return playlist.tracks[nextIdx] || null;
    }
    return null;
  };

  // Makes sure the next track is buffered in the standby <audio> (cache hit = instant).
  const ensureStandby = () => {
    const next = getNextTrack();
    if (!next || audioEngine.standbyFor(next.id)) return;
    const hit = peekStream(next.id);
    if (hit) preloadStandby(next.id, hit);
    else {
      resolveStream(next.id, { background: true })
        .then((d) => preloadStandby(next.id, d))
        .catch((e) => {
          if (e?.skipped) return;
          // one quiet retry so the next song is really ready before this one ends
          setTimeout(() => {
            if (getNextTrack()?.id !== next.id || audioEngine.standbyFor(next.id)) return;
            resolveStream(next.id, { forceRefresh: true }).then((d) => preloadStandby(next.id, d)).catch(() => {});
          }, 4000);
        });
    }
  };
  const ensureStandbyRef = useRef(null);
  ensureStandbyRef.current = ensureStandby;
  const standbyHalfwayRef = useRef(null); // track id for which the 50% safety preload already ran

  // Hand over to the next track RIGHT NOW, synchronously inside the "ended" event: play() the
  // already-buffered standby element and make it the active one. Works with the screen locked
  // because no network call / React render is needed first.
  const tryInstantAdvance = () => {
    const next = getNextTrack();
    if (!next) return false;
    if (!audioEngine.standbyFor(next.id)) {
      const hit = peekStream(next.id);
      if (hit && hit.type !== "hls") audioEngine.preload(next.id, hit.url);
    }
    if (!audioEngine.standbyFor(next.id)) {
      // Nothing buffered: keep the page audibly "alive" while the normal path resolves it.
      audioEngine.startKeepAlive();
      return false;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    const res = audioEngine.activateStandby({ volume, loop: false });
    if (!res) {
      audioEngine.startKeepAlive();
      return false;
    }
    loadTokenRef.current += 1;
    preAttachedIdRef.current = next.id;
    standbyHalfwayRef.current = null;
    if (Number.isFinite(res.el.duration)) setDuration(res.el.duration);
    res.promise?.catch((err) => {
      if (err?.name === "AbortError") return;
      console.warn("Instant advance play blocked:", err?.message || err);
      if (preAttachedIdRef.current === next.id) preAttachedIdRef.current = null;
      setIsPlaying(false);
    });
    return true;
  };

  const handleTrackEnded = () => {
    // Timer already expired while this song was finishing → stop, don't advance.
    if (checkSleepTimerRef.current?.()) return;
    if (earlyAdvanceFiredRef.current) return;
    if (repeatOne) {
      // Safety net — audio.loop normally handles this without an "ended" event.
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      }
      return;
    }
    if (!autoplay) {
      setIsPlaying(false);
      return;
    }
    tryInstantAdvance();
    if (activeSource === "search") {
      playNextAutoplayTrack();
    } else {
      handleNext();
      setIsPlaying(true);
    }
  };

  const toggleAutoplay = () => {
    setAutoplay((prev) => !prev);
  };

  const toggleRepeatOne = () => {
    triggerHaptic();
    setRepeatOne((prev) => !prev);
  };

  useEffect(() => {
    if (audioRef.current) audioRef.current.loop = repeatOne;
  }, [repeatOne]);

  // ---------- Coming back to the app ----------
  // If the track finished while the page was suspended (screen locked, other
  // app in front) its "ended" event may have been missed — on return, move on
  // instead of sitting on a finished song; and if the OS paused us without the
  // listener asking for it, resume.
  const resumeCheckRef = useRef(null);
  resumeCheckRef.current = () => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    if (checkSleepTimerRef.current?.()) return;
    if (document.hidden) return;
    if (audio.ended && autoplay && !repeatOne && !earlyAdvanceFiredRef.current) {
      handleTrackEnded();
    }
  };
  useEffect(() => {
    const run = () => resumeCheckRef.current?.();
    document.addEventListener("visibilitychange", run);
    window.addEventListener("pageshow", run);
    window.addEventListener("focus", run);
    return () => {
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("pageshow", run);
      window.removeEventListener("focus", run);
    };
  }, []);

  const selectPlaylistTrack = (idx) => {
    setActiveSource("playlist");
    setIsPlaying(true);

    if (idx === currentIndex) {
      // Same track is already selected (e.g. this is the only song in a
      // playlist that was just created/added to) — the track-loading
      // effect keys off currentTrack?.id, so it won't re-fire here and
      // nothing would actually tell the <audio> element to play, even
      // though setIsPlaying(true) makes the UI look like it's playing.
      // Kick playback directly instead.
      const audio = audioRef.current;
      if (audio) {
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            if (err.name !== "AbortError") {
              console.warn("Play error:", err.message || err);
              setIsPlaying(false);
            }
          });
        }
      }
    } else {
      setCurrentIndex(idx);
    }
  };

  const playSearchResult = (track) => {
    if (searchQuery.trim()) saveSearchQuery(searchQuery);
    setSearchTrack(track);
    setActiveSource("search");
    setIsPlaying(true);
  };

  // Plays a minimal stored track object (from Liked Songs or Recently
  // Played) the same way a search pick plays — resolveStream() only needs
  // the track id, so this works regardless of where the track originally
  // came from.
  const playStoredTrack = (track) => {
    if (!track) return;
    setSearchTrack(track);
    setActiveSource("search");
    setIsPlaying(true);
  };

  // ---------- Search page (opens when the search bar is clicked) ----------
  const [searchPageOpen, setSearchPageOpen] = useState(false);
  const searchPageInputRef = useRef(null);

  // Artist card (search) + artist page. `artistMatch` is the artist the current
  // query refers to (null when the query is not an artist name).
  const [artistMatch, setArtistMatch] = useState(null);
  const derivedArtist = useMemo(() => deriveArtistFromResults(searchQuery, searchResults), [searchQuery, searchResults]);
  const shownArtist = artistMatch || derivedArtist;
  const [artistPage, setArtistPage] = useState(null);

  const openArtistPage = (artist) => {
    if (!artist) return;
    window.history.pushState({ artistPage: true }, "");
    setArtistPage(artist);
  };
  const closeArtistPage = () => {
    if (window.history.state?.artistPage) window.history.back();
    else setArtistPage(null);
  };

  // Look the query up as an artist (photo + bio) alongside the song search.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setArtistMatch(null);
      return undefined;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      fetch(`${API_BASE}/api/artist?q=${encodeURIComponent(q)}`)
        .then((res) => (res.ok ? res.json() : { artist: null }))
        .then((data) => { if (!cancelled) setArtistMatch(data?.artist || null); })
        .catch(() => { if (!cancelled) setArtistMatch(null); });
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [searchQuery]);

  // YouTube Music "Songs" for the query (audio tracks with real artist / album
  // data — not videos), fetched in parallel with the YouTube search above. The
  // search page shows these first and keeps the YouTube results below them.
  const [musicResults, setMusicResults] = useState([]);
  const [isMusicSearching, setIsMusicSearching] = useState(false);
  useEffect(() => {
    const q = searchQuery.trim();
    setMusicResults([]);
    if (!q) {
      setIsMusicSearching(false);
      return undefined;
    }
    setIsMusicSearching(true);
    let cancelled = false;
    const handle = setTimeout(() => {
      fetch(`${API_BASE}/api/music-search?q=${encodeURIComponent(q)}`)
        .then((res) => (res.ok ? res.json() : { songs: [] }))
        .then((data) => {
          if (cancelled) return;
          const songs = (data?.songs || []).filter((t) => t?.id);
          setMusicResults(songs);
          // Pre-resolve the top songs so tapping one starts right away.
          songs.slice(0, 3).forEach((t, i) => setTimeout(() => warmStream(t.id), i * 300));
        })
        .catch(() => { if (!cancelled) setMusicResults([]); })
        .finally(() => { if (!cancelled) setIsMusicSearching(false); });
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [searchQuery]);

  // ---------- Voice search (Web Speech API) ----------
  const SpeechRec = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
  const voiceSupported = !!SpeechRec;
  const [listening, setListening] = useState(false);
  const recogRef = useRef(null);

  const stopVoice = useCallback(() => {
    try { recogRef.current?.stop(); } catch { /* ignore */ }
  }, []);

  const startVoice = useCallback(() => {
    if (!SpeechRec) {
      pushToast("Voice search isn't supported in this browser. Try Chrome, Edge or Safari.", "error", 5000);
      return;
    }
    if (recogRef.current) { stopVoice(); return; } // second tap = stop
    const r = new SpeechRec();
    r.lang = "en-IN"; // understands Hindi songs typed in English letters too
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    r.onstart = () => setListening(true);
    r.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i += 1) text += e.results[i][0].transcript;
      setSearchQuery(text.trim());
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        pushToast("Microphone permission is blocked. Allow it in your browser settings to use voice search.", "error", 6000);
      } else if (e.error === "no-speech") {
        pushToast("Didn't catch that — tap the mic and try again.", "error", 3500);
      } else if (e.error === "network") {
        pushToast("Voice search needs an internet connection.", "error", 4000);
      }
    };
    r.onend = () => { recogRef.current = null; setListening(false); };
    recogRef.current = r;
    try { r.start(); } catch { recogRef.current = null; setListening(false); }
  }, [SpeechRec, pushToast, stopVoice]);

  useEffect(() => () => { try { recogRef.current?.abort(); } catch { /* ignore */ } }, []);

  const openSearchPage = () => {
    if (searchPageOpen || window.history.state?.searchPage) return; // onFocus + onClick both fire
    window.history.pushState({ searchPage: true }, "");
    setSearchPageOpen(true);
  };
  const closeSearchPage = () => {
    stopVoice();
    if (window.history.state?.searchPage) window.history.back();
    else setSearchPageOpen(false);
  };

  useEffect(() => {
    // browser/phone Back button: close the artist page first (search stays
    // open underneath), then the search page itself.
    const onPop = () => {
      const st = window.history.state;
      if (!st?.artistPage) setArtistPage(null);
      setSearchPageOpen(!!(st?.searchPage || st?.artistPage));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!searchPageOpen) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = setTimeout(() => searchPageInputRef.current?.focus(), 50);
    const onKey = (e) => {
      if (e.key !== "Escape" || window.history.state?.artistPage) return; // artist page handles its own Escape
      closeSearchPage();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchPageOpen]);

  useEffect(() => {
    if (!artistPage) return undefined;
    const onKey = (e) => { if (e.key === "Escape") closeArtistPage(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artistPage]);

  // Search page lists: music songs + YouTube videos (minus any video that is
  // already shown as a song).
  const searchBusy = isSearching || isMusicSearching;
  const youtubeResults = useMemo(() => {
    if (!musicResults.length) return searchResults;
    const have = new Set(musicResults.map((t) => t.id));
    return searchResults.filter((t) => !have.has(t.id));
  }, [searchResults, musicResults]);

  const fmtDur = (d) => (typeof d === "number" && d > 0 ? formatTime(d) : typeof d === "string" ? d : "");

  const renderSearchCard = (track, hero = false) => {
    const isCurrent = currentTrack?.id === track.id;
    const playing = isCurrent && isPlaying;
    const liked = isTrackLiked(track.id);
    return (
      <div
        key={track.id}
        className={`sp-card ${hero ? "sp-card--hero" : ""} ${isCurrent ? "is-current" : ""}`}
        onPointerEnter={() => warmStream(track.id)}
        onTouchStart={() => warmStream(track.id)}
      >
        <button
          type="button"
          className="sp-hit"
          onClick={() => playSearchResult(track)}
          aria-label={`Play ${track.title}`}
        >
          <span className="sp-cover">
            <SearchCover id={track.id} src={track.thumbnailUrl} />
            <span className="sp-play">{playing ? <PauseIcon /> : <PlayIcon />}</span>
          </span>
          <span className="sp-meta">
            {track.playlistLabel && (
              <span className="sp-badge"><PlaylistBadgeIcon /> {track.playlistLabel}</span>
            )}
            <span className="sp-title" title={track.title}>{track.title}</span>
            <span className="sp-sub">
              {track.channel && <span className="sp-channel">{track.channel}</span>}
              {fmtDur(track.duration) && <span className="sp-dur">{fmtDur(track.duration)}</span>}
            </span>
          </span>
        </button>
        <div className="sp-actions">
          <button
            type="button"
            className={`sp-act ${liked ? "is-liked" : ""}`}
            aria-label={liked ? `Unlike ${track.title}` : `Like ${track.title}`}
            onClick={() => toggleLikeTrack(track)}
          >
            <HeartIcon filled={liked} />
          </button>
          <button
            type="button"
            className="sp-act"
            aria-label={`Save ${track.title} to a playlist`}
            onClick={() => openAddToPlaylistPicker(track)}
          >
            <PlusIcon />
          </button>
        </div>
      </div>
    );
  };

  // Lets the host shell (App.jsx) start a track in this player — used by the
  // "Recommended" mode cards. Plays exactly like a search pick: same dock,
  // same controls, same stream resolution. `nonce` makes re-clicking the same
  // track replay it.
  useEffect(() => {
    if (!playRequest?.track?.id) return;
    setSearchTrack(playRequest.track);
    setActiveSource("search");
    setIsPlaying(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playRequest?.nonce]);

  // ---------- Like / favorite ----------
  const isTrackLiked = useCallback(
    (trackId) => likedTracks.some((t) => t.id === trackId),
    [likedTracks]
  );

  const likedTracksRef = useRef(likedTracks);
  likedTracksRef.current = likedTracks;

  const toggleLikeTrack = useCallback((track) => {
    if (!track || !track.id) return;
    // Instagram-style burst, only when a song becomes liked (not on unlike).
    if (!likedTracksRef.current.some((t) => t.id === track.id)) burstHearts();
    setLikedTracks((prev) => {
      const alreadyLiked = prev.some((t) => t.id === track.id);
      const next = alreadyLiked
        ? prev.filter((t) => t.id !== track.id)
        : [
            { id: track.id, title: track.title, channel: track.channel || null },
            ...prev,
          ];
      persistLikedTracks(next);
      return next;
    });
  }, []);

  // ---------- Sleep timer ----------
  const clearSleepTimer = useCallback((notify = false) => {
    sleepEndAtRef.current = null;
    if (sleepTimerTimeoutRef.current) {
      clearTimeout(sleepTimerTimeoutRef.current);
      sleepTimerTimeoutRef.current = null;
    }
    setSleepTimerEndAt(null);
    setSleepTimerRemainingSecs(0);
    if (notify) pushToast("Sleep timer cancelled.", "success", 2500);
  }, [pushToast]);

  const startSleepTimer = useCallback(
    (minutes) => {
      const mins = Number(minutes);
      if (!mins || mins <= 0) return;
      if (sleepTimerTimeoutRef.current) clearTimeout(sleepTimerTimeoutRef.current);

      const endAt = Date.now() + mins * 60 * 1000;
      sleepEndAtRef.current = endAt;
      setSleepTimerEndAt(endAt);
      setSleepTimerRemainingSecs(mins * 60);

      // Music keeps playing (and auto-advancing) until the time is up; then it
      // stops. Two triggers for the stop: this timeout, and a wall-clock check
      // inside the audio events (see checkSleepTimer) as the backup.
      sleepTimerTimeoutRef.current = setTimeout(() => checkSleepTimerRef.current?.(true), mins * 60 * 1000);

      setShowSleepTimerModal(false);
      setCustomSleepMinutes("");
      pushToast(`Sleep timer set — stopping in ${mins} min.`, "success", 3000);
    },
    [pushToast]
  );

  const handleCustomSleepTimerSubmit = (e) => {
    e.preventDefault();
    startSleepTimer(customSleepMinutes);
  };

  // ---------- "Surprise me" ----------
  // One-tap random track, drawn from a rotating pool of mood/vibe queries
  // so a pick always fits the same late-night listening feel as the rest
  // of the app, instead of being fully arbitrary.
  const handleSurpriseMe = useCallback(() => {
    triggerHaptic();
    setIsSurpriseLoading(true);
    const q = SURPRISE_ME_QUERIES[Math.floor(Math.random() * SURPRISE_ME_QUERIES.length)];
    fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q)}`)
      .then((res) => res.json())
      .then((data) => {
        const results = data.results || [];
        if (!results.length) {
          pushToast("Couldn't find a surprise pick — try again.", "error");
          return;
        }
        const pick = results[Math.floor(Math.random() * results.length)];
        setSearchTrack(pick);
        setActiveSource("search");
        setIsPlaying(true);
      })
      .catch((err) => {
        console.error("Surprise me error:", err);
        pushToast("Surprise pick failed — try again.", "error");
      })
      .finally(() => setIsSurpriseLoading(false));
  }, [pushToast]);

  const handleSeek = (e) => {
    const value = Number(e.target.value);
    if (audioRef.current) audioRef.current.currentTime = value;
    setCurrentTime(value);
  };

  const handleVolumeChange = (e) => {
    const value = Number(e.target.value);
    setVolume(value);
    if (audioRef.current) audioRef.current.volume = value;
  };


  // Stops playback once the sleep timer's end time has passed. Returns true if
  // it fired. Safe to call any number of times (idempotent).
  const checkSleepTimerRef = useRef(null);
  checkSleepTimerRef.current = (force = false) => {
    const endAt = sleepEndAtRef.current;
    if (!endAt || (!force && Date.now() < endAt)) return false;
    sleepEndAtRef.current = null;
    if (sleepTimerTimeoutRef.current) {
      clearTimeout(sleepTimerTimeoutRef.current);
      sleepTimerTimeoutRef.current = null;
    }
    preAttachedIdRef.current = null;
    audioEngine.stopKeepAlive();
    const audio = audioRef.current;
    if (audio) audio.pause();
    setIsPlaying(false);
    setSleepTimerEndAt(null);
    setSleepTimerRemainingSecs(0);
    pushToast("Sleep timer ended — playback paused.", "success", 4500);
    return true;
  };

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (checkSleepTimerRef.current?.()) return;
    setCurrentTime(audio.currentTime);

    // ---------- Gapless background advance ----------
    // Why this exists: the normal "next track" trigger is the <audio>
    // element's native "ended" event (see handleTrackEnded below). But by
    // the time a track actually reaches "ended", audio.currentTime already
    // equals audio.duration — there is zero audio left to play. That means
    // the crossfade-out bridge (which plays the *outgoing* track's remaining
    // audio on a hidden second element while the next track's stream loads)
    // has nothing left to play either, so for that brief window NO <audio>
    // element on the page is actually producing sound.
    //
    // On desktop that's invisible. On a locked phone it's fatal: mobile
    // Chrome/WebView keeps a backgrounded tab's JS running specifically
    // because it holds an active, audibly-playing Media Session — the
    // instant that goes silent (even for under a second, while we fetch the
    // next stream URL), the OS is free to suspend the tab entirely. If that
    // happens before the fetch resolves, nothing ever calls audio.play()
    // again, and playback stays dead until the listener reopens the app.
    // That matches exactly what was reported: audio plays fine while
    // locked, but never advances past the first track ended while locked.
    //
    // Fix: don't wait for "ended" at all. Advance EARLY_ADVANCE_SECS before
    // the track actually finishes, while there's still real audio playing —
    // so the existing crossfade-out has genuine content to bridge with, the
    // Media Session never goes silent, and the OS has no excuse to suspend
    // the tab mid-transition. This also makes track transitions gapless
    // in the foreground as a nice side effect.
    if (
      autoplay &&
      !repeatOne &&
      !document.hidden &&
      !audioEngine.isYt() && // YouTube-player mode has no crossfade: let the song finish, "ended" advances
      !earlyAdvanceFiredRef.current &&
      !audioEngine.standbyFor(getNextTrack()?.id) && // standby ready: the gapless swap on "ended" is better
      Number.isFinite(audio.duration) &&
      audio.duration > EARLY_ADVANCE_SECS * 2 &&
      audio.currentTime > 0 &&
      audio.duration - audio.currentTime <= EARLY_ADVANCE_SECS
    ) {
      earlyAdvanceFiredRef.current = true;
      if (activeSource === "search") {
        playNextAutoplayTrack();
      } else if (playlist && playlist.tracks.length > 1) {
        handleNext();
        setIsPlaying(true);
      }
    }

    // Halfway through: make sure the next track is buffered in standby (safety net in case the
    // early prefetch failed or the page was busy). Position state: see useMediaSession.
    if (
      currentTrack?.id &&
      standbyHalfwayRef.current !== currentTrack.id &&
      Number.isFinite(audio.duration) &&
      audio.duration > 0 &&
      audio.currentTime / audio.duration >= 0.5
    ) {
      standbyHalfwayRef.current = currentTrack.id;
      ensureStandbyRef.current?.();
    }
  };

  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setDuration(audio.duration || 0);

    // Resume playback position — only ever applied once per page load, and
    // only to the exact track that was saved (matched by id), so switching
    // tracks afterward never unexpectedly jumps the seek bar.
    const saved = initialPlaybackStateRef.current;
    if (
      !resumeTimeAppliedRef.current &&
      saved &&
      saved.trackId &&
      currentTrack?.id === saved.trackId &&
      saved.currentTime > 2 &&
      saved.currentTime < audio.duration
    ) {
      resumeTimeAppliedRef.current = true;
      audio.currentTime = saved.currentTime;
      setCurrentTime(saved.currentTime);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchResults([]);
  };

  // --- Local (on-device) custom playlist handlers ---
  // Every one of these only ever touches component state + localStorage —
  // nothing here ever calls the server.

  const openCreatePlaylistModal = () => {
    setNewPlaylistName("");
    setShowCreatePlaylistModal(true);
  };

  const closeCreatePlaylistModal = () => {
    setShowCreatePlaylistModal(false);
    setNewPlaylistName("");
  };

  const handleCreatePlaylist = (e) => {
    e.preventDefault();
    const label = newPlaylistName.trim();
    if (!label) return;

    const newPlaylist = {
      id: `local:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label,
      tracks: addToPlaylistTrack ? [addToPlaylistTrack] : [],
      createdAt: Date.now(),
    };

    const next = [...customPlaylists, newPlaylist];
    setCustomPlaylists(next);
    persistLocalPlaylists(next);
    setShowCreatePlaylistModal(false);
    setNewPlaylistName("");

    if (addToPlaylistTrack) {
      setAddToPlaylistFeedback(`Saved to "${label}" on this device`);
      setAddToPlaylistTrack(null);
      setTimeout(() => setAddToPlaylistFeedback(""), 2000);
    } else {
      setActivePlaylistId(newPlaylist.id);
    }
  };

  const handleDeleteLocalPlaylist = (playlistId, e) => {
    e.stopPropagation();
    const next = customPlaylists.filter((p) => p.id !== playlistId);
    setCustomPlaylists(next);
    persistLocalPlaylists(next);
    if (activePlaylistId === playlistId) {
      setActivePlaylistId(playlists.length > 0 ? playlists[0].id : "default");
    }
  };

  // Opens the "save this song to a playlist" picker for a given track
  // (works for search results, the currently-playing track, and tracks
  // already sitting in a server playlist's queue).
  const openAddToPlaylistPicker = (track) => {
    setAddToPlaylistFeedback("");
    setAddToPlaylistTrack(track);
  };

  // Lets the host shell (App.jsx) drive like / add-to-playlist from the
  // "Recommended" cards with the very same logic the search cards use.
  useEffect(() => {
    onPlayerApi?.({
      toggleLike: toggleLikeTrack,
      addToPlaylist: openAddToPlaylistPicker,
      openArtist: openArtistPage,                 // Recommended page: artist strip -> artist page
      selectPlaylist: (id) => setActivePlaylistId(id), // Recommended page: playlist cards (same as a sidebar tab click)
    });
  });
  // Tell the host which playlists exist (Recommended page shows them between the song shelves).
  useEffect(() => {
    onPlaylistsChange?.({ radio: playlists, custom: customPlaylists, activeId: activePlaylistId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlists, customPlaylists, activePlaylistId]);
  useEffect(() => {
    onLikedChange?.(likedTracks.map((t) => t.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [likedTracks]);

  const closeAddToPlaylistPicker = () => {
    setAddToPlaylistTrack(null);
    setAddToPlaylistFeedback("");
  };

  const handleAddTrackToLocalPlaylist = (playlistId) => {
    if (!addToPlaylistTrack) return;
    const next = customPlaylists.map((p) => {
      if (p.id !== playlistId) return p;
      const alreadyIn = p.tracks.some((t) => t.id === addToPlaylistTrack.id);
      if (alreadyIn) return p;
      return { ...p, tracks: [...p.tracks, addToPlaylistTrack] };
    });
    setCustomPlaylists(next);
    persistLocalPlaylists(next);

    const target = next.find((p) => p.id === playlistId);
    setAddToPlaylistFeedback(`Saved to "${target?.label}" on this device`);
    setTimeout(() => {
      setAddToPlaylistTrack(null);
      setAddToPlaylistFeedback("");
    }, 900);
  };

  const handleRemoveTrackFromLocalPlaylist = (trackId, e) => {
    e.stopPropagation();
    const next = customPlaylists.map((p) =>
      p.id === activePlaylistId ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) } : p
    );
    setCustomPlaylists(next);
    persistLocalPlaylists(next);
  };

  // --- Backup (download) and restore (upload) for the on-device custom
  // playlists ---
  // These playlists live ONLY in this browser's localStorage (see the note
  // at the top of the file), so they disappear if the site's cache/data
  // gets cleared, or simply don't exist on a different device/browser.
  // These two handlers let the listener download a JSON snapshot of
  // everything they've saved here, and later load that same file back in
  // — on this device or any other — to restore it. Like everything else
  // in this block, neither of these ever talks to the server.
  const handleExportLocalPlaylists = () => {
    try {
      const payload = {
        app: "raunaknama",
        type: "local-playlists-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        playlists: customPlaylists,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `raunaknama-playlists-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("Could not export local playlists:", err);
      window.alert("Couldn't create the backup file — see console for details.");
    }
  };

  const triggerImportLocalPlaylists = () => {
    importFileInputRef.current?.click();
  };

  const handleImportLocalPlaylistsFile = (e) => {
    const file = e.target.files && e.target.files[0];
    // Reset the input so picking the same file again still fires onChange.
    e.target.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const incoming = Array.isArray(parsed) ? parsed : parsed.playlists;
        if (!Array.isArray(incoming)) {
          throw new Error("This file doesn't look like a playlists backup.");
        }

        // Merge rather than overwrite: a playlist missing locally (deleted,
        // or this is a different browser) is restored in full; a playlist
        // that still exists locally gets the backup's tracks merged in
        // (de-duplicated by track id) so nothing added since the backup
        // was taken gets lost.
        const merged = [...customPlaylists];
        let restoredCount = 0;
        incoming.forEach((incomingPlaylist) => {
          if (
            !incomingPlaylist ||
            !incomingPlaylist.id ||
            !Array.isArray(incomingPlaylist.tracks)
          ) {
            return;
          }
          restoredCount += 1;
          const existingIdx = merged.findIndex((p) => p.id === incomingPlaylist.id);
          if (existingIdx === -1) {
            merged.push(incomingPlaylist);
          } else {
            const existing = merged[existingIdx];
            const existingTrackIds = new Set(existing.tracks.map((t) => t.id));
            const mergedTracks = [
              ...existing.tracks,
              ...incomingPlaylist.tracks.filter((t) => t && !existingTrackIds.has(t.id)),
            ];
            merged[existingIdx] = { ...existing, tracks: mergedTracks };
          }
        });

        setCustomPlaylists(merged);
        persistLocalPlaylists(merged);
        window.alert(`Restored ${restoredCount} playlist(s) from backup.`);
      } catch (err) {
        console.warn("Could not import local playlists:", err);
        window.alert(
          "Couldn't read that file — make sure it's a playlists backup exported from here."
        );
      }
    };
    reader.readAsText(file);
  };

  // Shared by custom + radio playlist sharing: native share sheet on touch
  // devices, otherwise copy the link to the clipboard.
  const deliverShareUrl = async (url, label) => {
    const touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    if (navigator.share && touch) {
      try {
        await navigator.share({ title: label, text: `Listen to "${label}" on Raunaknama`, url });
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
      }
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      pushToast("Playlist link copied — send it to anyone!", "success");
    } else {
      window.prompt("Copy this playlist link:", url);
    }
  };

  // Radio playlists live on the server for everyone, so their link is just
  // a short ?radio=<id> — opening it jumps straight to that playlist.
  const handleShareRadioPlaylist = async (playlist, e) => {
    e?.stopPropagation();
    try {
      const url = `${window.location.origin}${window.location.pathname}?radio=${encodeURIComponent(playlist.id)}`;
      await deliverShareUrl(url, playlist.label);
    } catch (err) {
      console.warn("Could not share radio playlist:", err);
      pushToast("Couldn't create the share link.", "error");
    }
  };

  // --- Share a custom playlist as a link ---
  const handleSharePlaylist = async (playlist, e) => {
    e?.stopPropagation();
    if (!playlist?.tracks?.length) {
      pushToast("Add a few songs to this playlist before sharing it.", "error");
      return;
    }
    try {
      const code = await encodePlaylistShare(playlist);
      const url = `${window.location.origin}${window.location.pathname}?pl=${code}`;
      if (url.length > 7500) {
        pushToast("Big playlist — if the link doesn't open for a friend, use Download backup instead.", "error", 6000);
      }
      await deliverShareUrl(url, playlist.label);
    } catch (err) {
      console.warn("Could not share playlist:", err);
      pushToast("Couldn't create the share link.", "error");
    }
  };

  const clearShareParam = () => {
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("pl");
      window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
    } catch {
      /* ignore */
    }
  };

  const handleCancelImport = () => {
    setImportPreview(null);
    clearShareParam();
  };

  const handleConfirmImport = () => {
    if (!importPreview) return;
    const signature = (tracks) => tracks.map((t) => t.id).sort().join(",");
    const incomingSig = signature(importPreview.tracks);
    const existing = customPlaylists.find((p) => signature(p.tracks) === incomingSig);
    if (existing) {
      setActivePlaylistId(existing.id);
      pushToast(`"${existing.label}" is already saved on this device.`, "success");
    } else {
      const created = {
        id: `local:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        label: importPreview.label,
        tracks: importPreview.tracks,
        createdAt: Date.now(),
      };
      const next = [...customPlaylists, created];
      setCustomPlaylists(next);
      persistLocalPlaylists(next);
      setActivePlaylistId(created.id);
      pushToast(`Saved "${created.label}" (${created.tracks.length} songs) to Your playlists.`, "success", 5500);
    }
    setImportPreview(null);
    clearShareParam();
  };

  const seekTo = (value) => {
    if (audioRef.current) audioRef.current.currentTime = value;
    setCurrentTime(value);
  };

  const weekStats = menuOpen ? computeWeekStats(statsRef.current || { days: {} }) : null;

  const isActivePlaylistLocal = activePlaylistId.startsWith("local:");

  const showResultsDropdown = searchFocused && (searchQuery.trim().length > 0);

  return (
    <div className="player-shell">
      {/* ---------- Hamburger drawer: playlists, custom playlists, backup ---------- */}
      <div
        className={`drawer-overlay ${menuOpen ? "is-open" : ""}`}
        onClick={onCloseMenu}
        aria-hidden="true"
      />
      <aside className={`drawer custom-scrollbar ${menuOpen ? "is-open" : ""}`} aria-hidden={!menuOpen}>
        <div className="drawer-head">
          <h3 className="drawer-title"><Icon name="radio" /> Playlists</h3>
          <button type="button" className="drawer-close" onClick={onCloseMenu} aria-label="Close menu">
            <CloseIcon />
          </button>
        </div>

        <div className="drawer-body">
          {onModeChange && (
            <div className="drawer-section drawer-mode">
              <p className="drawer-section-label">Mode</p>
              <div className="drawer-mode-switch" role="radiogroup" aria-label="Mode" data-mode={mode}>
                <span className="drawer-mode-thumb" aria-hidden="true" />
                {[["default", "Default", "radio"], ["recommended", "Recommended", "sparkles"]].map(([id, label, icon]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={mode === id}
                    className={`drawer-mode-btn ${mode === id ? "is-active" : ""}`}
                    onClick={() => { onModeChange(id); onCloseMenu?.(); }}
                  >
                    <Icon name={icon} /> {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {playlists.length > 0 && (
            <div className="drawer-section">
              <p className="drawer-section-label">Radio playlists</p>
              <div className="playlist-tabs" role="tablist" aria-label="Choose a playlist">
                {playlists.map((p) => (
                  <button
                    key={p.id}
                    role="tab"
                    aria-selected={p.id === activePlaylistId}
                    className={`playlist-tab is-local ${p.id === activePlaylistId ? "is-active" : ""}`}
                    onClick={() => setActivePlaylistId(p.id)}
                  >
                    <span>{p.label}</span>
                    <span
                      className="playlist-tab-delete playlist-tab-share"
                      role="button"
                      aria-label={`Share playlist ${p.label}`}
                      title="Share this playlist (link)"
                      onClick={(e) => handleShareRadioPlaylist(p, e)}
                    >
                      <ShareIcon />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {playlist && (
            <div className="drawer-section queue-drawer-section">
              <button
                type="button"
                className="queue-toggle drawer-queue-toggle"
                onClick={() => setShowQueue((s) => !s)}
                aria-expanded={showQueue}
              >
                <span className="drawer-section-label queue-drawer-label">
                  <Icon name="listMusic" /> Now Playing Queue &middot; {playlist.tracks.length} tracks
                </span>
                <ChevronIcon open={showQueue} />
              </button>

              <div className={`queue-list drawer-queue-list custom-scrollbar ${showQueue ? "is-open" : ""}`}>
                {playlist.tracks.map((track, idx) => {
                  const isSelected = activeSource === "playlist" && idx === currentIndex;
                  return (
                    <div
                      key={track.id}
                      onClick={() => selectPlaylistTrack(idx)}
                      className={`queue-item ${isSelected ? "is-selected" : ""}`}
                    >
                      <span className="queue-item-index">
                        {isSelected ? <Icon name={isPlaying ? "music" : "pause"} size="0.95em" /> : idx + 1}
                      </span>
                      <span className="queue-item-title line-clamp-2">{track.title}</span>
                      <span className="queue-item-actions">
                        <span
                          className="queue-item-action"
                          role="button"
                          aria-label={isTrackLiked(track.id) ? `Unlike ${track.title}` : `Like ${track.title}`}
                          title={isTrackLiked(track.id) ? "Remove from Liked Songs" : "Add to Liked Songs"}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleLikeTrack(track);
                          }}
                        >
                          <HeartIcon filled={isTrackLiked(track.id)} />
                        </span>
                        {isActivePlaylistLocal ? (
                          <span
                            className="queue-item-action"
                            role="button"
                            aria-label={`Remove ${track.title} from this playlist`}
                            title="Remove from this playlist"
                            onClick={(e) => handleRemoveTrackFromLocalPlaylist(track.id, e)}
                          >
                            <TrashIcon />
                          </span>
                        ) : (
                          <span
                            className="queue-item-action"
                            role="button"
                            aria-label={`Save ${track.title} to a playlist`}
                            title="Save to playlist (on this device)"
                            onClick={(e) => {
                              e.stopPropagation();
                              openAddToPlaylistPicker(track);
                            }}
                          >
                            <PlusIcon />
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="drawer-section queue-drawer-section">
            <button
              type="button"
              className="queue-toggle drawer-queue-toggle"
              onClick={() => setShowLikedSongs((s) => !s)}
              aria-expanded={showLikedSongs}
            >
              <span className="drawer-section-label queue-drawer-label">
                <HeartIcon filled /> Liked Songs &middot; {likedTracks.length}
              </span>
              <ChevronIcon open={showLikedSongs} />
            </button>
            <div className={`queue-list drawer-queue-list custom-scrollbar ${showLikedSongs ? "is-open" : ""}`}>
              {likedTracks.length === 0 && (
                <p className="playlist-modal-empty">No liked songs yet — tap the heart on any track.</p>
              )}
              {likedTracks.map((track) => (
                <div key={track.id} className="queue-item" onClick={() => playStoredTrack(track)}>
                  <span className="queue-item-index" aria-hidden="true">
                    <HeartIcon filled />
                  </span>
                  <span className="queue-item-title line-clamp-2">{track.title}</span>
                  <span
                    className="queue-item-action"
                    role="button"
                    aria-label={`Unlike ${track.title}`}
                    title="Remove from Liked Songs"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleLikeTrack(track);
                    }}
                  >
                    <TrashIcon />
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="drawer-section queue-drawer-section">
            <button
              type="button"
              className="queue-toggle drawer-queue-toggle"
              onClick={() => setShowRecentlyPlayed((s) => !s)}
              aria-expanded={showRecentlyPlayed}
            >
              <span className="drawer-section-label queue-drawer-label">
                <HistoryIcon /> Recently Played &middot; {recentlyPlayed.length}
              </span>
              <ChevronIcon open={showRecentlyPlayed} />
            </button>
            <div className={`queue-list drawer-queue-list custom-scrollbar ${showRecentlyPlayed ? "is-open" : ""}`}>
              {recentlyPlayed.length === 0 && (
                <p className="playlist-modal-empty">Nothing played yet this session.</p>
              )}
              {recentlyPlayed.map((track, idx) => (
                <div key={`${track.id}-${idx}`} className="queue-item" onClick={() => playStoredTrack(track)}>
                  <span className="queue-item-index">{idx + 1}</span>
                  <span className="queue-item-title line-clamp-2">{track.title}</span>
                  <span
                    className="queue-item-action"
                    role="button"
                    aria-label={isTrackLiked(track.id) ? `Unlike ${track.title}` : `Like ${track.title}`}
                    title={isTrackLiked(track.id) ? "Remove from Liked Songs" : "Add to Liked Songs"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleLikeTrack(track);
                    }}
                  >
                    <HeartIcon filled={isTrackLiked(track.id)} />
                  </span>
                </div>
              ))}
            </div>
          </div>

          {weekStats && (
            <div className="drawer-section listening-card">
              <p className="drawer-section-label">Your week</p>
              {weekStats.totalSecs < 30 ? (
                <p className="playlist-modal-empty">Play some songs — your weekly listening stats will show up here.</p>
              ) : (
                <>
                  <div className="listening-total">
                    <span className="listening-total-num">{formatListenTime(weekStats.totalSecs)}</span>
                    <span className="listening-total-sub">listened in the last 7 days</span>
                  </div>
                  <div className="listening-bars" aria-hidden="true">
                    {weekStats.days.map((d, i) => (
                      <div key={i} className={`listening-bar ${d.isToday ? "is-today" : ""}`}>
                        <span className="listening-bar-fill" style={{ height: `${Math.max(6, (d.secs / weekStats.maxDay) * 100)}%` }} />
                        <span className="listening-bar-day">{d.label}</span>
                      </div>
                    ))}
                  </div>
                  {weekStats.topArtist && (
                    <p className="listening-line"><span>Top artist</span><strong title={weekStats.topArtist.name}>{weekStats.topArtist.name}</strong></p>
                  )}
                  {weekStats.topTrack && (
                    <p className="listening-line"><span>Most played</span><strong title={weekStats.topTrack.name}>{weekStats.topTrack.name}</strong></p>
                  )}
                </>
              )}
            </div>
          )}

          <div className="drawer-section local-playlists-block">
            <p className="drawer-section-label">Your playlists</p>
            <div className="playlist-tabs local-playlists-tabs" role="tablist" aria-label="Your custom playlists">
              {customPlaylists.map((p) => (
                <button
                  key={p.id}
                  role="tab"
                  aria-selected={p.id === activePlaylistId}
                  className={`playlist-tab is-local ${p.id === activePlaylistId ? "is-active" : ""}`}
                  onClick={() => setActivePlaylistId(p.id)}
                >
                  <DeviceIcon />
                  <span>{p.label}</span>
                  <span
                    className="playlist-tab-delete playlist-tab-share"
                    role="button"
                    aria-label={`Share playlist ${p.label}`}
                    title="Share this playlist (link)"
                    onClick={(e) => handleSharePlaylist(p, e)}
                  >
                    <ShareIcon />
                  </span>
                  <span
                    className="playlist-tab-delete"
                    role="button"
                    aria-label={`Delete playlist ${p.label}`}
                    onClick={(e) => handleDeleteLocalPlaylist(p.id, e)}
                  >
                    <TrashIcon />
                  </span>
                </button>
              ))}
              <button className="playlist-tab playlist-tab--create" onClick={openCreatePlaylistModal}>
                <PlusIcon />
                <span>New playlist</span>
              </button>
            </div>
            <p className="local-playlists-note">
              <DeviceIcon /> Ye custom playlists sirf isi device/browser par locally save hoti hain, server par nahi — cache ya browser data clear karne par ye gayab ho jayengi.
            </p>

            <div className="local-playlists-backup-actions">
              <button
                type="button"
                className="playlist-modal-btn playlist-modal-btn--ghost local-playlists-backup-btn"
                onClick={handleExportLocalPlaylists}
                title="Download all your on-device playlists as a JSON backup file"
              >
                <SaveIcon /> Download backup
              </button>
              <button
                type="button"
                className="playlist-modal-btn playlist-modal-btn--ghost local-playlists-backup-btn"
                onClick={triggerImportLocalPlaylists}
                title="Restore playlists from a previously downloaded backup file"
              >
                <UploadIcon /> Upload backup
              </button>
              <input
                ref={importFileInputRef}
                type="file"
                accept="application/json,.json"
                onChange={handleImportLocalPlaylistsFile}
                style={{ display: "none" }}
              />
            </div>
          </div>

          <AppDownloads />
        </div>
      </aside>

      {/* ---------- Search ---------- */}
      <div className="search-wrap">
        <div className={`search-box ${searchFocused ? "is-focused" : ""}`}>
          <SearchIcon />
          <input
            type="text"
            value={searchQuery}
            readOnly
            onClick={openSearchPage}
            onFocus={openSearchPage}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search any song&hellip;"
            className="search-input"
            aria-label="Search any song"
          />
          {searchQuery && (
            <button className="search-clear" onClick={clearSearch} aria-label="Clear search">
              <CloseIcon />
            </button>
          )}
          {voiceSupported && (
            <button
              type="button"
              className={`voice-btn ${listening ? "is-listening" : ""}`}
              onClick={() => { openSearchPage(); startVoice(); }}
              aria-label="Search by voice"
              title="Search by voice"
            >
              <Icon name="mic" />
            </button>
          )}
          <button
            type="button"
            className={`surprise-me-btn ${isSurpriseLoading ? "is-loading" : ""}`}
            onClick={handleSurpriseMe}
            disabled={isSurpriseLoading}
            aria-label="Surprise me with a random track"
            title="Surprise me — one-tap random track"
          >
            {isSurpriseLoading ? <LoadingSpinnerIcon size={14} /> : <DiceIcon />}
            <span className="surprise-me-label">Surprise me</span>
          </button>
        </div>

      </div>

      {/* ---------- Full search page ---------- */}
      {searchPageOpen && (
        <div className="sp-page" role="dialog" aria-modal="true" aria-label="Search">
          <div className="sp-top">
            <button type="button" className="sp-back" onClick={closeSearchPage} aria-label="Back">
              <BackIcon />
            </button>
            <div className="sp-field">
              <SearchIcon />
              <input
                ref={searchPageInputRef}
                type="search"
                className="sp-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveSearchQuery(searchQuery); }}
                placeholder={listening ? "Listening… say a song or artist" : "Search any song…"}
                aria-label="Search any song"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="search"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="sp-clear"
                  onClick={() => { setSearchQuery(""); searchPageInputRef.current?.focus(); }}
                  aria-label="Clear search"
                >
                  <CloseIcon />
                </button>
              )}
              {voiceSupported && (
                <button
                  type="button"
                  className={`voice-btn ${listening ? "is-listening" : ""}`}
                  onClick={startVoice}
                  aria-label={listening ? "Stop listening" : "Search by voice"}
                  aria-pressed={listening}
                  title={listening ? "Stop listening" : "Search by voice"}
                >
                  <Icon name="mic" />
                </button>
              )}
            </div>
          </div>

          <div className="sp-body custom-scrollbar">
            {!searchQuery.trim() && (
              <div className="sp-empty">
                <span className="sp-empty-icon" aria-hidden="true"><SearchIcon /></span>
                <h2 className="sp-empty-title">Find any song</h2>
                <p className="sp-empty-sub">Type a song, an artist or a few words from the lyrics.</p>
              </div>
            )}

            {/* History (this device only) + suggestions */}
            <SearchHistory query={searchQuery} onPick={(q) => { setSearchQuery(q); searchPageInputRef.current?.focus(); }} />

            {searchQuery.trim() && shownArtist && (
              <>
                <h2 className="sp-heading">Artist</h2>
                <ArtistSearchCard artist={shownArtist} onOpen={openArtistPage} />
              </>
            )}

            {searchQuery.trim() && searchBusy && (
              <div className="sp-grid" aria-hidden="true">
                {Array.from({ length: 8 }, (_, i) => <div key={i} className="sp-card sp-skel" />)}
              </div>
            )}

            {searchQuery.trim() && !searchBusy && musicResults.length === 0 && searchResults.length === 0 && (
              <div className="sp-empty">
                <h2 className="sp-empty-title">No results</h2>
                <p className="sp-empty-sub">Nothing found for “{searchQuery}”. Try another spelling.</p>
              </div>
            )}

            {/* Music songs first (audio tracks, like the Recommended cards)… */}
            {searchQuery.trim() && !searchBusy && musicResults.length > 0 && (
              <>
                <h2 className="sp-heading">Top result</h2>
                {renderSearchCard(musicResults[0], true)}
                {musicResults.length > 1 && (
                  <>
                    <h2 className="sp-heading">Songs</h2>
                    <div className="sp-grid">
                      {musicResults.slice(1, 13).map((t) => renderSearchCard(t))}
                    </div>
                  </>
                )}
              </>
            )}

            {/* …then the YouTube videos, exactly as they were. With no music
                results (music search down / nothing found) this is the original
                "Top result" + "Songs" layout. */}
            {searchQuery.trim() && !searchBusy && youtubeResults.length > 0 && (
              <>
                {musicResults.length > 0 ? (
                  <>
                    <h2 className="sp-heading">From YouTube</h2>
                    <div className="sp-grid">
                      {youtubeResults.map((t) => renderSearchCard(t))}
                    </div>
                  </>
                ) : (
                  <>
                    <h2 className="sp-heading">Top result</h2>
                    {renderSearchCard(youtubeResults[0], true)}
                    {youtubeResults.length > 1 && (
                      <>
                        <h2 className="sp-heading">Songs</h2>
                        <div className="sp-grid">
                          {youtubeResults.slice(1).map((t) => renderSearchCard(t))}
                        </div>
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------- Artist page (opens from the artist card in search) ---------- */}
      {artistPage && (
        <ArtistPage
          key={artistPage.name}
          artist={artistPage}
          onClose={closeArtistPage}
          renderTrack={(t) => renderSearchCard(t)}
          onPlay={playSearchResult}
        />
      )}

      {/* ---------- Bottom-docked player bar ----------
          Everything below (queue, now-playing header, and the transport
          card) is anchored together as one fixed group at the bottom
          center of the viewport, so the full-bleed background photo stays
          visible everywhere above it. Nothing here was removed — the
          queue simply renders first in this wrapper so it expands
          upward, above the compact bar, instead of pushing the bar
          off-screen. */}
      <div className="player-dock">
        {!isOnline && (
          <div className="offline-banner" role="status">
            <OfflineIcon />
            You're offline — playback may be interrupted
          </div>
        )}

        {loading && (
          <div className="state-card state-card--inline">
            <span className="state-disc" aria-hidden="true" />
            <p className="state-title">Warming up the mic&hellip;</p>
            <p className="state-sub">Loading your playlist…</p>
          </div>
        )}

        {!loading && error && (
          <div className="state-card state-card--error state-card--inline">
            <p className="state-title state-title--error">Signal lost</p>
            <p className="state-sub">{error}</p>
          </div>
        )}

        {!loading && !error && currentTrack && (
          <>
            <div className="now-playing-head">
            <div>
              <span className="eyebrow">
                <EqualizerIcon active={isPlaying} />
                {activeSource === "search" ? "Playing from search" : "Now Playing"}
              </span>
              <h2 className="playlist-title">
                <Icon name="mic2" />{" "}
                {activeSource === "search" ? "Custom pick" : playlist?.playlistTitle}
              </h2>
            </div>
            <div className="now-playing-head-actions">
              <button
                type="button"
                className={`add-to-playlist-btn add-to-playlist-btn--header like-btn ${isTrackLiked(currentTrack.id) ? "is-liked" : ""}`}
                aria-label={isTrackLiked(currentTrack.id) ? `Unlike ${currentTrack.title}` : `Like ${currentTrack.title}`}
                title={isTrackLiked(currentTrack.id) ? "Remove from Liked Songs" : "Add to Liked Songs"}
                onClick={() => toggleLikeTrack(currentTrack)}
              >
                <HeartIcon filled={isTrackLiked(currentTrack.id)} />
              </button>
              <button
                type="button"
                className="add-to-playlist-btn add-to-playlist-btn--header"
                aria-label={`Save ${currentTrack.title} to a playlist`}
                title="Save to playlist (on this device)"
                onClick={() => openAddToPlaylistPicker(currentTrack)}
              >
                <SaveIcon />
              </button>
              <button
                type="button"
                className="add-to-playlist-btn add-to-playlist-btn--header fullview-toggle-btn"
                aria-label="Open full player view"
                title="Full view"
                onClick={() => setShowFullView(true)}
              >
                <ExpandIcon />
              </button>
              <button
                type="button"
                className={`add-to-playlist-btn add-to-playlist-btn--header lyrics-toggle-btn ${showLyrics ? "is-active" : ""}`}
                aria-label={showLyrics ? "Hide lyrics" : "Show lyrics"}
                aria-pressed={showLyrics}
                title="Lyrics"
                onClick={() => setShowLyrics((v) => !v)}
              >
                <MicIcon />
              </button>
            </div>
          </div>

          <div className="orb-stage">
            <div className="orb-row">
              <div className={`player-orb ${isPlaying ? "is-spinning" : ""}`} aria-hidden="true">
                <span className={`orb-ring ${isPlaying ? "is-active" : ""}`} />
                <span className={`orb-ring orb-ring--runner ${isPlaying ? "is-active" : ""}`} />
                <button
                  type="button"
                  className={`orb-play-btn ${isTrackLoading ? "is-loading" : ""}`}
                  onClick={togglePlayPause}
                  aria-label={isTrackLoading ? "Loading" : isPlaying ? "Pause" : "Play"}
                >
                  {isTrackLoading ? (
                    <LoadingSpinnerIcon />
                  ) : isPlaying ? (
                    <PauseIcon />
                  ) : (
                    <PlayIcon />
                  )}
                </button>
              </div>

              <div className="volume-vertical">
                <input
                  type="range"
                  className="volume-bar volume-bar--vertical"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={handleVolumeChange}
                  aria-label="Volume"
                  aria-orientation="vertical"
                />
                <VolumeIcon />
              </div>
            </div>

            <div className="track-info">
              <p className="track-title track-swap" key={`t-${currentTrack.id}`}>{currentTrack.title}</p>
              <p className="track-meta track-swap track-swap--late" key={`m-${currentTrack.id}`}>
                {activeSource === "search"
                  ? currentTrack.channel || "From search"
                  : `Track ${currentIndex + 1} of ${playlist.tracks.length}`}
                {isTrackLoading && (
                  <span className="track-loading-tag">
                    <LoadingSpinnerIcon size={11} />
                    Loading&hellip;
                  </span>
                )}
              </p>
            </div>

            {/* Audio lives in src/lib/audioEngine.js: two persistent <audio> elements (primary + standby). */}

            {playbackError && (
              <p className="state-sub playback-error-note" role="status">
                {scrubBrand(playbackError)}
              </p>
            )}

            <div className="seek-row">
              <span className="time">{formatTime(currentTime)}</span>
              <div className="seek-track-wrap">
                <span
                  className={`seek-progress-glow ${isPlaying ? "is-playing" : ""}`}
                  style={{
                    width: `${duration ? Math.min(100, (currentTime / duration) * 100) : 0}%`,
                  }}
                  aria-hidden="true"
                />
                <input
                  type="range"
                  className="seek-bar"
                  min="0"
                  max={duration || 0}
                  step="0.1"
                  value={Math.min(currentTime, duration || 0)}
                  onChange={handleSeek}
                  aria-label="Seek"
                />
              </div>
              <span className="time">{formatTime(duration)}</span>
            </div>

            <div className="controls-row">
              <button
                className={`ctrl-btn shuffle-btn ${shuffle ? "is-active" : ""}`}
                onClick={toggleShuffle}
                aria-label="Toggle shuffle"
                aria-pressed={shuffle}
                disabled={activeSource === "search"}
              >
                <ShuffleIcon />
              </button>
              <button className="ctrl-btn" onClick={handlePrev} aria-label="Previous track">
                <PrevIcon />
              </button>
              <button className="ctrl-btn" onClick={handleNext} aria-label="Next track">
                <NextIcon />
              </button>
              <button
                className={`ctrl-btn autoplay-btn ${autoplay ? "is-active" : ""}`}
                onClick={toggleAutoplay}
                aria-label="Toggle autoplay"
                aria-pressed={autoplay}
              >
                <AutoplayIcon />
              </button>
              <button
                className={`ctrl-btn repeat-one-btn ${repeatOne ? "is-active" : ""}`}
                onClick={toggleRepeatOne}
                aria-label={repeatOne ? "Repeat this song: on" : "Repeat this song: off"}
                aria-pressed={repeatOne}
                title="Repeat this song"
              >
                <RepeatOneIcon />
              </button>
              <button
                className={`ctrl-btn sleep-timer-btn ${sleepTimerEndAt ? "is-active" : ""}`}
                onClick={() => setShowSleepTimerModal(true)}
                aria-label={sleepTimerEndAt ? `Sleep timer — ${formatTime(sleepTimerRemainingSecs)} left` : "Set sleep timer"}
                aria-pressed={!!sleepTimerEndAt}
                title={sleepTimerEndAt ? `Stops in ${formatTime(sleepTimerRemainingSecs)}` : "Sleep timer"}
              >
                <MoonIcon />
              </button>
            </div>
            {sleepTimerEndAt && (
              <p className="sleep-timer-note" role="status">
                <MoonIcon /> Stopping in {formatTime(sleepTimerRemainingSecs)}
              </p>
            )}
          </div>
          </>
        )}
      </div>

      {showCreatePlaylistModal && (
        <div className="playlist-modal-overlay" onMouseDown={closeCreatePlaylistModal}>
          <form
            className="playlist-modal"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={handleCreatePlaylist}
          >
            <h3 className="playlist-modal-title">New playlist</h3>
            <p className="playlist-modal-sub">
              <DeviceIcon /> Ye sirf isi device par save hogi — server par nahi jaati.
            </p>
            <input
              type="text"
              autoFocus
              className="playlist-modal-input"
              placeholder="Playlist name&hellip;"
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              maxLength={60}
            />
            <div className="playlist-modal-actions">
              <button type="button" className="playlist-modal-btn playlist-modal-btn--ghost" onClick={closeCreatePlaylistModal}>
                Cancel
              </button>
              <button type="submit" className="playlist-modal-btn playlist-modal-btn--primary" disabled={!newPlaylistName.trim()}>
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {addToPlaylistTrack && !showCreatePlaylistModal && (
        <div className="playlist-modal-overlay" onMouseDown={closeAddToPlaylistPicker}>
          <div className="playlist-modal" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="playlist-modal-title">Save to playlist</h3>
            <p className="playlist-modal-sub line-clamp-2">
              <DeviceIcon /> &ldquo;{addToPlaylistTrack.title}&rdquo; — locally saved, browser data clear karne par gayab ho jayegi.
            </p>

            {addToPlaylistFeedback ? (
              <p className="playlist-modal-feedback">{addToPlaylistFeedback}</p>
            ) : (
              <>
                <div className="playlist-modal-list custom-scrollbar">
                  {customPlaylists.length === 0 && (
                    <p className="playlist-modal-empty">No playlists yet — create one below.</p>
                  )}
                  {customPlaylists.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="playlist-modal-item"
                      onClick={() => handleAddTrackToLocalPlaylist(p.id)}
                    >
                      <DeviceIcon />
                      <span className="line-clamp-2">{p.label}</span>
                      <span className="playlist-modal-item-count">{p.tracks.length}</span>
                    </button>
                  ))}
                </div>
                <div className="playlist-modal-actions">
                  <button type="button" className="playlist-modal-btn playlist-modal-btn--ghost" onClick={closeAddToPlaylistPicker}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="playlist-modal-btn playlist-modal-btn--primary"
                    onClick={openCreatePlaylistModal}
                  >
                    <PlusIcon /> New playlist
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showSleepTimerModal && (
        <div className="playlist-modal-overlay" onMouseDown={() => setShowSleepTimerModal(false)}>
          <form
            className="playlist-modal"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={handleCustomSleepTimerSubmit}
          >
            <h3 className="playlist-modal-title">Sleep timer</h3>
            <p className="playlist-modal-sub">
              <MoonIcon /> Stop playback after a set time — pick a slot or set a custom one.
            </p>

            <div className="sleep-timer-presets">
              {SLEEP_TIMER_PRESETS_MIN.map((mins) => (
                <button
                  key={mins}
                  type="button"
                  className="sleep-timer-preset-btn"
                  onClick={() => startSleepTimer(mins)}
                >
                  {mins} min
                </button>
              ))}
            </div>

            <div className="sleep-timer-custom-row">
              <input
                type="number"
                min="1"
                max="600"
                inputMode="numeric"
                className="playlist-modal-input sleep-timer-custom-input"
                placeholder="Custom minutes&hellip;"
                value={customSleepMinutes}
                onChange={(e) => setCustomSleepMinutes(e.target.value)}
              />
              <button
                type="submit"
                className="playlist-modal-btn playlist-modal-btn--primary"
                disabled={!customSleepMinutes || Number(customSleepMinutes) <= 0}
              >
                Set
              </button>
            </div>

            {sleepTimerEndAt && (
              <p className="playlist-modal-feedback">
                Stopping in {formatTime(sleepTimerRemainingSecs)}
              </p>
            )}

            <div className="playlist-modal-actions">
              {sleepTimerEndAt && (
                <button
                  type="button"
                  className="playlist-modal-btn playlist-modal-btn--ghost"
                  onClick={() => clearSleepTimer(true)}
                >
                  Cancel timer
                </button>
              )}
              <button
                type="button"
                className="playlist-modal-btn playlist-modal-btn--ghost"
                onClick={() => setShowSleepTimerModal(false)}
              >
                Close
              </button>
            </div>
          </form>
        </div>
      )}

      {showFullView && currentTrack && (
        <FullPlayer
          track={currentTrack}
          coverUrl={currentTrack.albumCover || (currentTrack.isMusic ? currentTrack.thumbnailUrl : null)}
          backgroundImageUrl={backgroundImageUrl}
          eyebrow={activeSource === "search" ? "Playing from search" : "Now Playing"}
          subtitle={activeSource === "search" ? "Custom pick" : playlist?.playlistTitle}
          isPlaying={isPlaying}
          isTrackLoading={isTrackLoading}
          currentTime={currentTime}
          duration={duration}
          volume={volume}
          shuffle={shuffle}
          autoplay={autoplay}
          repeatOne={repeatOne}
          liked={isTrackLiked(currentTrack.id)}
          shuffleDisabled={activeSource === "search"}
          syncedLines={shownLyrics?.synced || []}
          lyricsLoading={lyricsLoading}
          scriptMode={activeScript}
          onScriptMode={setScriptMode}
          scriptEnabled={hasAnyLyrics}
          onClose={() => setShowFullView(false)}
          onTogglePlay={togglePlayPause}
          onPrev={handlePrev}
          onNext={handleNext}
          onSeek={seekTo}
          onVolume={handleVolumeChange}
          onToggleShuffle={toggleShuffle}
          onToggleAutoplay={toggleAutoplay}
          onToggleRepeat={toggleRepeatOne}
          onToggleLike={() => toggleLikeTrack(currentTrack)}
          onOpenSynced={() => setShowSyncLyrics(true)}
          onOpenLyrics={() => setShowLyrics(true)}
          icons={{ PlayIcon, PauseIcon, PrevIcon, NextIcon, ShuffleIcon, AutoplayIcon, RepeatOneIcon, HeartIcon, MicIcon, SyncIcon, LoadingSpinnerIcon, VolumeIcon }}
        />
      )}

      {showLyrics && currentTrack && (
        <div className="lyrics-modal-overlay" onMouseDown={() => setShowLyrics(false)}>
          <div className="lyrics-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="lyrics-modal-head">
              <div className="lyrics-modal-head-text">
                <span className="lyrics-modal-eyebrow">
                  <MicIcon size={13} /> Lyrics
                </span>
                <h3 className="lyrics-modal-title line-clamp-2">{currentTrack.title}</h3>
              </div>
              {hasAnyLyrics && <ScriptToggle mode={activeScript} onChange={setScriptMode} />}
              <button
                type="button"
                className="lyrics-sync-btn"
                disabled={lyricsLoading || !lyricsData?.synced?.length}
                title={lyricsData?.synced?.length ? "Open full-screen synced lyrics" : "Synced lyrics aren't available for this song"}
                onClick={() => { setShowLyrics(false); setShowSyncLyrics(true); }}
              >
                <SyncIcon /> {lyricsLoading || lyricsData?.synced?.length ? "Synced view" : "No synced lyrics"}
              </button>
              <button
                type="button"
                className="lyrics-modal-close"
                aria-label="Close lyrics"
                onClick={() => setShowLyrics(false)}
              >
                <CloseIcon />
              </button>
            </div>

            <div className="lyrics-modal-body">
              {lyricsLoading && (
                <div className="lyrics-state">
                  <LoadingSpinnerIcon size={26} />
                  <p>Fetching lyrics&hellip;</p>
                </div>
              )}

              {!lyricsLoading && lyricsData && !lyricsData.available && (
                <div className="lyrics-state lyrics-state--empty">
                  <MicIcon size={26} />
                  <p>Lyrics not available for this track.</p>
                </div>
              )}

              {!lyricsLoading && lyricsData?.available && lyricsData.instrumental && (
                <div className="lyrics-state lyrics-state--empty">
                  <MicIcon size={26} />
                  <p>This track is instrumental — no lyrics to show.</p>
                </div>
              )}

              {!lyricsLoading && lyricsData?.available && !lyricsData.instrumental && (
                <div className="lyrics-plain">
                  {/* Plain, unsynchronised lyrics only — just the words for this
                      track, no timestamp tracking or active-line highlighting.
                      Prefer lrclib's plain-text lyrics; if only synced (timed)
                      lyrics came back, strip the timing and show the text. */}
                  {(shownLyrics.plain
                    ? shownLyrics.plain.split(/\r?\n/)
                    : (shownLyrics.synced || []).map((l) => l.text).filter(Boolean)
                  ).map((line, idx) => (
                    <p key={idx} className="lyrics-line" dir="auto">
                      {line || "\u00A0"}
                    </p>
                  ))}
                </div>
              )}
            </div>

            <p className="lyrics-modal-footer">{lyricsData?.available && lyricsData.source ? `Lyrics via ${lyricsData.source}` : "Lyrics"}</p>
          </div>
        </div>
      )}

      {showSyncLyrics && currentTrack && (
        <SyncedLyrics
          track={currentTrack}
          lines={shownLyrics?.synced || []}
          scriptMode={activeScript}
          onScriptMode={setScriptMode}
          loading={lyricsLoading}
          currentTime={currentTime}
          duration={duration}
          isPlaying={isPlaying}
          onClose={() => setShowSyncLyrics(false)}
          onSeek={seekTo}
          onTogglePlay={togglePlayPause}
          onPrev={handlePrev}
          onNext={handleNext}
          onShowPlain={() => { setShowSyncLyrics(false); setShowLyrics(true); }}
        />
      )}

      {importPreview && (
        <div className="playlist-modal-overlay" onMouseDown={handleCancelImport}>
          <div className="playlist-modal share-import-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="playlist-modal-title">Playlist shared with you</h3>
            <p className="playlist-modal-sub">
              <ShareIcon /> <strong>{importPreview.label}</strong> &middot; {importPreview.tracks.length} songs
            </p>
            <ul className="share-import-list">
              {importPreview.tracks.slice(0, 5).map((t) => (
                <li key={t.id} className="line-clamp-2">{t.title}</li>
              ))}
              {importPreview.tracks.length > 5 && (
                <li className="share-import-more">+ {importPreview.tracks.length - 5} more</li>
              )}
            </ul>
            <div className="playlist-modal-actions">
              <button type="button" className="playlist-modal-btn playlist-modal-btn--ghost" onClick={handleCancelImport}>
                Not now
              </button>
              <button type="button" className="playlist-modal-btn playlist-modal-btn--primary" onClick={handleConfirmImport}>
                Save to my playlists
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Toasts ----------
          Small, auto-dismissing notifications for stream/playlist/search
          errors and network status changes — fixed on top of everything
          else so they're visible regardless of which player state or
          modal is currently showing. */}
      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast--${t.type}`}>
              <span className="toast-message">{t.message}</span>
              <button
                type="button"
                className="toast-dismiss"
                onClick={() => dismissToast(t.id)}
                aria-label="Dismiss notification"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
