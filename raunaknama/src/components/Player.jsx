import React, { useEffect, useState, useRef, useCallback } from "react";
import Hls from "hls.js";
import "./Player.css";

// How long we trust a resolved stream URL client-side before re-resolving.
// Kept comfortably under the server's own 2h cache window (see
// STREAM_CACHE_TTL_MS in ytdlpService.mjs) so we basically never re-hit the
// backend for a track that's already been resolved this session — that's
// what makes prev/next feel instant instead of waiting on yt-dlp again.
const CLIENT_STREAM_CACHE_TTL_MS = 100 * 60 * 1000;

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

// Crossfade duration between tracks — the outgoing track fades out on a
// secondary <audio> element while the incoming one fades in on the primary
// element, so there's real overlap instead of a hard cut.
const CROSSFADE_MS = 1500;

// Smoothly ramps an <audio> element's volume from `from` to `to` over
// `durationMs`, driven by requestAnimationFrame. `rafRef` is a ref used to
// track/cancel the in-flight ramp so a new one (e.g. a rapid track skip)
// doesn't fight with a previous one still running.
const rampAudioVolume = (el, from, to, durationMs, rafRef, onDone) => {
  if (!el) return;
  if (rafRef.current) cancelAnimationFrame(rafRef.current);
  const start = performance.now();
  const clamp = (v) => Math.min(1, Math.max(0, v));
  try {
    el.volume = clamp(from);
  } catch (err) {
    // Element may already be detached/gone — nothing to animate.
    return;
  }
  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    try {
      el.volume = clamp(from + (to - from) * t);
    } catch (err) {
      rafRef.current = null;
      return;
    }
    if (t < 1) {
      rafRef.current = requestAnimationFrame(step);
    } else {
      rafRef.current = null;
      if (onDone) onDone();
    }
  };
  rafRef.current = requestAnimationFrame(step);
};

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

export default function Player({ onTrackChange, menuOpen, onCloseMenu }) {
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

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
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
  const pushToast = useCallback((message, type = "error", durationMs = 4500) => {
    if (!message) return;
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

  const audioRef = useRef(null);
  // ---------- Crossfade ----------
  // A second, hidden <audio> element used only to play out the *outgoing*
  // track's tail while the primary element loads and fades in the next
  // one — see the "Managed Safe Audio Loading" effect below.
  const crossfadeAudioRef = useRef(null);
  const hasLoadedTrackRef = useRef(false); // false only before the very first track ever attaches
  const pendingFadeInRef = useRef(false); // set when the next 'playing' event should ramp volume up instead of jumping to it
  const fadeInRafRef = useRef(null);
  const fadeOutRafRef = useRef(null);
  const importFileInputRef = useRef(null); // hidden <input type="file"> for restoring a local-playlists backup
  const consecutiveFailures = useRef(0);
  const hlsRef = useRef(null);
  const streamCacheRef = useRef(new Map()); // trackId -> { data: {url,type}, expires }
  const loadTokenRef = useRef(0); // guards against a stale resolve landing after a newer track switch
  const autoplayHistoryRef = useRef(new Set()); // recently auto-played track ids, so the "similar songs" chain doesn't immediately repeat itself
  const retriedTrackIdsRef = useRef(new Set()); // track ids that already got one forced (cache-bypassing) re-resolve after a playback failure
  const prefetchedAutoplayRef = useRef(null); // { seedId, track } — the next "similar songs" autoplay pick, looked up + stream-resolved ahead of time

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
          setActivePlaylistId((prev) =>
            data.playlists.some((p) => p.id === prev) ? prev : data.playlists[0].id
          );
        }
      })
      .catch((err) => console.error("Playlists list fetch error:", err));
  }, []);

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

    fetch(`${API_BASE}/api/playlist?playlistId=${activePlaylistId}`)
      .then((res) => {
        // Read the body even on failure — the Netlify function returns a
        // JSON {error, details} payload explaining exactly why it failed
        // (e.g. "yt-dlp binary not found" or "YouTube blocked server IP").
        // Previously this was thrown away, so the console only ever showed
        // a generic "Failed to load playlist from server" with no way to
        // diagnose the real cause. Now we surface it.
        return res.json().then((data) => {
          if (!res.ok) {
            const reason = data?.details || data?.error || `HTTP ${res.status}`;
            throw new Error(reason);
          }
          return data;
        });
      })
      .then((data) => {
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
        console.error("Playlist Fetch Error:", err);
        setError(`Could not load playlist: ${err.message}`);
        setLoading(false);
        pushToast(`Could not load playlist: ${err.message}`, "error");
      });
  }, [activePlaylistId, customPlaylists, pushToast]);

  // 2. Search Debounce
  useEffect(() => {
    if (!searchQuery.trim()) {
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
        .then((results) => setSearchResults(results))
        .catch((err) => {
          console.error("Search error:", err);
          setSearchResults([]);
          pushToast(
            isOnline ? "Search failed — please try again." : "You're offline — search unavailable.",
            "error"
          );
        })
        .finally(() => setIsSearching(false));
    }, 450);

    return () => clearTimeout(handle);
  }, [searchQuery, pushToast, isOnline]);

  const currentTrack =
    activeSource === "search" ? searchTrack : playlist?.tracks?.[currentIndex];

  // Resolves a track ID to { url, type: "direct"|"hls" }, via an in-memory
  // client-side cache first (instant, no network at all) and falling back
  // to /api/stream (which has its own server-side cache on top of yt-dlp).
  const resolveStream = useCallback((trackId, { forceRefresh = false } = {}) => {
    if (!forceRefresh) {
      const cached = streamCacheRef.current.get(trackId);
      if (cached && cached.expires > Date.now()) {
        return Promise.resolve(cached.data);
      }
    }
    const streamUrl = forceRefresh
      ? `${API_BASE}/api/stream?id=${trackId}&retry=1`
      : `${API_BASE}/api/stream?id=${trackId}`;
    return fetch(streamUrl)
      .then((res) => {
        if (!res.ok) {
          return res
            .json()
            .catch(() => ({}))
            .then((body) => {
              // Keep both the short error and the raw yt-dlp details (when
              // present) so the console shows the *actual* reason a stream
              // failed to resolve — e.g. "YouTube blocked server IP. Please
              // set YTDLP_COOKIES_B64..." — instead of a vague generic
              // message that hides what's actually wrong.
              const err = new Error(body.error || `Stream resolve failed (${res.status})`);
              err.details = body.details;
              throw err;
            });
        }
        return res.json();
      })
      .then((data) => {
        if (!data.url) throw new Error("No stream URL returned");
        streamCacheRef.current.set(trackId, {
          data,
          expires: Date.now() + CLIENT_STREAM_CACHE_TTL_MS,
        });
        return data;
      });
  }, []);

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
    }
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
    resolveStream(nextTrack.id).catch(() => {});
  }, [playlist, currentIndex, shuffle, shuffleOrder, activeSource, resolveStream]);

  // 3. Managed Safe Audio Loading without Race Conditions.
  // Resolves the current track to a real URL + format type, then either:
  //   - hands the URL straight to the <audio> element (direct/progressive), or
  //   - spins up hls.js to play an HLS (.m3u8) stream, which plain <audio
  //     src="..."> cannot do in Chrome/Firefox.
  useEffect(() => {
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

    // ---------- Crossfade out the previous track ----------
    // Only once we've already had a real track playing (never on the very
    // first load) — hand the outgoing audio's current position off to the
    // hidden secondary element, let it keep playing while it fades to
    // silence over CROSSFADE_MS, then mute the primary element so the
    // incoming track starts silent and ready to fade in once it's playing.
    if (hasLoadedTrackRef.current && audio.src) {
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

    resolveStream(currentTrack.id)
      .then((data) => {
        if (cancelled || token !== loadTokenRef.current) return;
        setIsTrackLoading(false);
        attachStreamAndPlay(data, token, wantsPlay);
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
        if (!isCookieError && trackId && !retriedTrackIdsRef.current.has(trackId)) {
          retriedTrackIdsRef.current.add(trackId);
          resolveStream(trackId, { forceRefresh: true })
            .then((data) => {
              if (cancelled || token !== loadTokenRef.current) return;
              setIsTrackLoading(false);
              attachStreamAndPlay(data, token, wantsPlay);
            })
            .catch((err2) => {
              if (cancelled || token !== loadTokenRef.current) return;
              console.warn("Stream re-resolve also failed:", err2.message);
              setIsTrackLoading(false);
              handleStreamFailure(err2.details || err2.message);
            });
          return;
        }

        setIsTrackLoading(false);
        handleStreamFailure(err.details || err.message);
      });

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

  // ---------- Media Session API ----------
  // Powers lock-screen / notification-shade playback controls and
  // earphone/Bluetooth media buttons — without this, backgrounding the tab
  // or locking the phone leaves the listener with no way to control
  // playback at all.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentTrack) return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: currentTrack.title || "Raunaknama",
        artist:
          activeSource === "search"
            ? currentTrack.channel || "Raunaknama"
            : playlist?.playlistTitle || "Raunaknama",
        album: "Raunaknama",
        artwork: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      });
    } catch (err) {
      // Not supported in this browser — harmless to skip.
    }
  }, [currentTrack?.id, currentTrack?.title, currentTrack?.channel, activeSource, playlist?.playlistTitle]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  // Re-registered every render (cheap) so each handler always closes over
  // the latest handleNext/handlePrev/audioRef — these aren't memoized, so a
  // one-time (mount-only) registration would go stale after the first
  // track change.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const setHandler = (action, handler) => {
      try {
        ms.setActionHandler(action, handler);
      } catch (err) {
        // Action not supported in this browser — harmless to skip.
      }
    };

    setHandler("play", () => {
      const audio = audioRef.current;
      if (audio) audio.play().catch(() => {});
    });
    setHandler("pause", () => {
      audioRef.current?.pause();
    });
    setHandler("previoustrack", () => handlePrev());
    setHandler("nexttrack", () => handleNext());
    setHandler("seekbackward", (details) => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10));
    });
    setHandler("seekforward", (details) => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = Math.min(
        audio.duration || Infinity,
        audio.currentTime + (details.seekOffset || 10)
      );
    });
    setHandler("seekto", (details) => {
      const audio = audioRef.current;
      if (audio && details.seekTime != null) audio.currentTime = details.seekTime;
    });

    return () => {
      ["play", "pause", "previoustrack", "nexttrack", "seekbackward", "seekforward", "seekto"].forEach(
        (action) => setHandler(action, null)
      );
    };
  });

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

  const handleStreamFailure = (message) => {
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

    consecutiveFailures.current += 1;
    if (consecutiveFailures.current > 3) {
      const stopMsg =
        "Several tracks in a row failed to stream. The backend (yt-dlp) is likely blocked or down.";
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
    if (trackId && !retriedTrackIdsRef.current.has(trackId)) {
      retriedTrackIdsRef.current.add(trackId);
      const token = ++loadTokenRef.current;
      resolveStream(trackId, { forceRefresh: true })
        .then((data) => {
          if (token !== loadTokenRef.current) return;
          attachStreamAndPlay(data, token, true);
        })
        .catch((err) => {
          if (token !== loadTokenRef.current) return;
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

  const handleAudioPlaying = () => {
    consecutiveFailures.current = 0;
    setPlaybackError(null);
    setIsPlaying(true);

    // If this "playing" is the start of a freshly-switched track (see the
    // crossfade-out kickoff in the loading effect), ramp its volume up from
    // silent instead of jumping straight to full — that's the "fade in"
    // half of the crossfade.
    if (pendingFadeInRef.current) {
      pendingFadeInRef.current = false;
      const audio = audioRef.current;
      if (audio) {
        rampAudioVolume(audio, 0, volume, CROSSFADE_MS, fadeInRafRef);
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
        resolveStream(next.id).catch(() => {});
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
  const handleTrackEnded = () => {
    if (!autoplay) {
      setIsPlaying(false);
      return;
    }
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
    setSearchTrack(track);
    setActiveSource("search");
    setIsPlaying(true);
  };

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

  const lastPositionStateRef = useRef(0);

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(audio.currentTime);

    // Keep the lock-screen / notification scrubber in sync — throttled so
    // we're not calling this on every ~250ms timeupdate tick.
    if ("mediaSession" in navigator && audio.duration && Number.isFinite(audio.duration)) {
      const now = Date.now();
      if (now - lastPositionStateRef.current > 900) {
        lastPositionStateRef.current = now;
        try {
          navigator.mediaSession.setPositionState({
            duration: audio.duration,
            playbackRate: audio.playbackRate || 1,
            position: Math.min(audio.currentTime, audio.duration),
          });
        } catch (err) {
          // Not supported in this browser — harmless to skip.
        }
      }
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
          <h3 className="drawer-title"><span aria-hidden="true">📻</span> Playlists</h3>
          <button type="button" className="drawer-close" onClick={onCloseMenu} aria-label="Close menu">
            <CloseIcon />
          </button>
        </div>

        <div className="drawer-body">
          {playlists.length > 0 && (
            <div className="drawer-section">
              <p className="drawer-section-label">Radio playlists</p>
              <div className="playlist-tabs" role="tablist" aria-label="Choose a playlist">
                {playlists.map((p) => (
                  <button
                    key={p.id}
                    role="tab"
                    aria-selected={p.id === activePlaylistId}
                    className={`playlist-tab ${p.id === activePlaylistId ? "is-active" : ""}`}
                    onClick={() => setActivePlaylistId(p.id)}
                  >
                    {p.label}
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
                  <span aria-hidden="true">🎶</span> Now Playing Queue &middot; {playlist.tracks.length} tracks
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
                        {isSelected ? (isPlaying ? "♪" : "❚❚") : idx + 1}
                      </span>
                      <span className="queue-item-title line-clamp-2">{track.title}</span>
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
                    </div>
                  );
                })}
              </div>
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
        </div>
      </aside>

      {/* ---------- Search ---------- */}
      <div className="search-wrap">
        <div className={`search-box ${searchFocused ? "is-focused" : ""}`}>
          <SearchIcon />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
            placeholder="Search any song on YouTube&hellip;"
            className="search-input"
            aria-label="Search any song"
          />
          {searchQuery && (
            <button className="search-clear" onClick={clearSearch} aria-label="Clear search">
              <CloseIcon />
            </button>
          )}
        </div>

        {showResultsDropdown && (
          <div className="search-results custom-scrollbar">
            {isSearching && <div className="search-status">Searching&hellip;</div>}
            {!isSearching && searchResults.length === 0 && (
              <div className="search-status">No results for &ldquo;{searchQuery}&rdquo;</div>
            )}
            {!isSearching &&
              searchResults.map((track) => (
                <div
                  key={track.id}
                  className="search-result-item"
                  onMouseDown={() => playSearchResult(track)}
                >
                  <div className="search-result-text">
                    <span className="search-result-title line-clamp-2">{track.title}</span>
                    {track.channel && <span className="search-result-channel">{track.channel}</span>}
                  </div>
                  <button
                    type="button"
                    className="add-to-playlist-btn"
                    aria-label={`Save ${track.title} to a playlist`}
                    title="Save to playlist (on this device)"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      openAddToPlaylistPicker(track);
                    }}
                  >
                    <PlusIcon />
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>

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
            <p className="state-sub">Fetching the playlist via yt-dlp.</p>
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
                <span aria-hidden="true">🎙️</span>{" "}
                {activeSource === "search" ? "Custom pick" : playlist?.playlistTitle}
              </h2>
            </div>
            <button
              type="button"
              className="add-to-playlist-btn add-to-playlist-btn--header"
              aria-label={`Save ${currentTrack.title} to a playlist`}
              title="Save to playlist (on this device)"
              onClick={() => openAddToPlaylistPicker(currentTrack)}
            >
              <SaveIcon />
            </button>
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
                  disabled={isTrackLoading}
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
              <p className="track-title">{currentTrack.title}</p>
              <p className="track-meta">
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

            <audio
              ref={audioRef}
              onPlay={() => setIsPlaying(true)}
              onPlaying={handleAudioPlaying}
              onPause={() => setIsPlaying(false)}
              onEnded={handleTrackEnded}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onError={handleAudioError}
              className="native-audio"
            />

            {/* Hidden — used only to play out the tail of the outgoing
                track while it crossfades to silence (see the "Managed Safe
                Audio Loading" effect). Never exposed to any controls. */}
            <audio ref={crossfadeAudioRef} className="native-audio" aria-hidden="true" />

            {playbackError && (
              <p className="state-sub playback-error-note" role="status">
                {playbackError}
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
            </div>
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
