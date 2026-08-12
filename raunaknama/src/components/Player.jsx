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

const formatTime = (secs) => {
  if (!secs || Number.isNaN(secs) || !Number.isFinite(secs)) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
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

export default function Player() {
  const [playlist, setPlaylist] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [playlists, setPlaylists] = useState([]);
  const [activePlaylistId, setActivePlaylistId] = useState("default");

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
  const [searchTrack, setSearchTrack] = useState(null);
  const [activeSource, setActiveSource] = useState("playlist");

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [showQueue, setShowQueue] = useState(false);

  const [playbackError, setPlaybackError] = useState(null);

  // Custom playlists that any listener can create — saved only on THIS
  // device (localStorage), never on the server.
  const [customPlaylists, setCustomPlaylists] = useState(() => loadLocalPlaylists());
  const [showCreatePlaylistModal, setShowCreatePlaylistModal] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState(null); // track object currently being saved
  const [addToPlaylistFeedback, setAddToPlaylistFeedback] = useState("");

  const audioRef = useRef(null);
  const consecutiveFailures = useRef(0);
  const hlsRef = useRef(null);
  const streamCacheRef = useRef(new Map()); // trackId -> { data: {url,type}, expires }
  const loadTokenRef = useRef(0); // guards against a stale resolve landing after a newer track switch
  const autoplayHistoryRef = useRef(new Set()); // recently auto-played track ids, so the "similar songs" chain doesn't immediately repeat itself

  // 0. Fetch available playlists once. This runs in parallel with the
  // playlist-metadata fetch below (which now defaults to "default" instead
  // of waiting on this to resolve first) — cuts a full network round-trip
  // off the time-to-first-track.
  useEffect(() => {
    fetch(`${API_BASE}/api/playlists`)
      .then((res) => res.json())
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

    // Local (on-device) custom playlists never touch the network — they're
    // read straight out of component state, which itself is backed by
    // this browser's localStorage.
    if (activePlaylistId.startsWith("local:")) {
      const local = customPlaylists.find((p) => p.id === activePlaylistId);
      setPlaylist({
        playlistTitle: local ? local.label : "Custom playlist",
        tracks: local ? local.tracks : [],
      });
      setCurrentIndex(0);
      setShuffle(false);
      setShuffleOrder([]);
      setActiveSource("playlist");
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
        if (!res.ok) throw new Error("Failed to load playlist from server");
        return res.json();
      })
      .then((data) => {
        if (data.tracks && data.tracks.length > 0) {
          setPlaylist(data);
          setCurrentIndex(0);
          setShuffle(false);
          setShuffleOrder([]);
          setActiveSource("playlist");
        } else {
          setError("No tracks found in playlist");
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error("Playlist Fetch Error:", err);
        setError("Could not connect to streaming server.");
        setLoading(false);
      });
  }, [activePlaylistId, customPlaylists]);

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
        .then((res) => res.json())
        .then((data) => setSearchResults(data.results || []))
        .catch((err) => {
          console.error("Search error:", err);
          setSearchResults([]);
        })
        .finally(() => setIsSearching(false));
    }, 450);

    return () => clearTimeout(handle);
  }, [searchQuery]);

  const currentTrack =
    activeSource === "search" ? searchTrack : playlist?.tracks?.[currentIndex];

  // Resolves a track ID to { url, type: "direct"|"hls" }, via an in-memory
  // client-side cache first (instant, no network at all) and falling back
  // to /api/stream (which has its own server-side cache on top of yt-dlp).
  const resolveStream = useCallback((trackId) => {
    const cached = streamCacheRef.current.get(trackId);
    if (cached && cached.expires > Date.now()) {
      return Promise.resolve(cached.data);
    }
    return fetch(`${API_BASE}/api/stream?id=${trackId}`)
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
      return;
    }

    const token = ++loadTokenRef.current;
    let cancelled = false;

    setCurrentTime(0);
    setDuration(0);
    setPlaybackError(null);

    const wantsPlay = isPlaying;

    const startPlayback = () => {
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

    resolveStream(currentTrack.id)
      .then((data) => {
        if (cancelled || token !== loadTokenRef.current) return;

        const nativeHlsSupport = audio.canPlayType("application/vnd.apple.mpegurl");

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
            if (!errData.fatal || cancelled || token !== loadTokenRef.current) return;
            console.warn("HLS fatal error:", errData.type, errData.details);
            handleStreamFailure();
          });
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled || token !== loadTokenRef.current) return;
            startPlayback();
          });
          hls.loadSource(data.url);
          hls.attachMedia(audio);
        } else {
          // Direct/progressive URL — or a browser (Safari) that plays HLS
          // natively via the <audio> element, no hls.js needed.
          audio.src = data.url;
          audio.load();
          startPlayback();
        }
      })
      .catch((err) => {
        if (cancelled || token !== loadTokenRef.current) return;
        console.warn("Stream resolve error:", err.message, err.details ? `— ${err.details}` : "");
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

  // 4. Playback Controls
  const handleNext = () => {
    if (!playlist) return;
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

    // "Sign in to confirm you're not a bot" / cookie-required failures are a
    // config problem, not a bad track — every track will fail the same way,
    // so skipping through the whole playlist just burns yt-dlp calls and
    // buries the real reason under "skipping…" noise. Surface it plainly
    // and stop, rather than auto-advancing.
    if (message && /cookie|sign in to confirm/i.test(message)) {
      setPlaybackError(message);
      return;
    }

    consecutiveFailures.current += 1;
    if (consecutiveFailures.current > 3) {
      setPlaybackError(
        "Several tracks in a row failed to stream. The backend (yt-dlp) is likely blocked or down."
      );
      return;
    }

    setPlaybackError(message || "Couldn't play this track — skipping…");
    if (activeSource === "playlist" && playlist && playlist.tracks.length > 1) {
      setTimeout(() => handleNext(), 1200);
    }
  };

  const handleAudioError = () => {
    const mediaError = audioRef.current?.error;
    console.warn("Audio element error:", mediaError?.message || mediaError);
    handleStreamFailure();
  };

  const handleAudioPlaying = () => {
    consecutiveFailures.current = 0;
    setPlaybackError(null);
    setIsPlaying(true);
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

  const playNextAutoplayTrack = () => {
    const seed = currentTrack;
    if (!seed) {
      setIsPlaying(false);
      return;
    }
    const q = `${seed.channel || seed.title} song`;
    fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q)}`)
      .then((res) => res.json())
      .then((data) => {
        const candidates = (data.results || []).filter(
          (t) =>
            t.id !== seed.id &&
            !autoplayHistoryRef.current.has(t.id) &&
            t.duration &&
            t.duration <= MAX_AUTOPLAY_DURATION_SECS
        );
        const next = candidates[Math.floor(Math.random() * candidates.length)];
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
    setCurrentIndex(idx);
    setIsPlaying(true);
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

  const handleTimeUpdate = () => {
    if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) setDuration(audioRef.current.duration || 0);
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

  const isActivePlaylistLocal = activePlaylistId.startsWith("local:");

  const showResultsDropdown = searchFocused && (searchQuery.trim().length > 0);

  return (
    <div className="player-card">
      {playlists.length > 0 && (
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
      )}

      <div className="local-playlists-block">
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
      </div>

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
          <div className="player-card-header">
            <div>
              <span className="eyebrow">
                {activeSource === "search" ? "Playing from search" : "Now Playing"}
              </span>
              <h2 className="playlist-title">
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

          <div className="stage-main">
            <div className={`disc ${isPlaying ? "is-spinning" : ""}`} aria-hidden="true">
              <div className="disc-hole" />
            </div>

            <div className="track-info">
              <p className="track-title">{currentTrack.title}</p>
              <p className="track-meta">
                {activeSource === "search"
                  ? currentTrack.channel || "From search"
                  : `Track ${currentIndex + 1} of ${playlist.tracks.length}`}
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

            {playbackError && (
              <p className="state-sub" role="status" style={{ color: "#f87171", margin: "4px 0 0" }}>
                {playbackError}
              </p>
            )}

            <div className="seek-row">
              <span className="time">{formatTime(currentTime)}</span>
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
              <button
                className="ctrl-btn play-btn"
                onClick={togglePlayPause}
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
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

            <div className="volume-row">
              <VolumeIcon />
              <input
                type="range"
                className="volume-bar"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={handleVolumeChange}
                aria-label="Volume"
              />
            </div>
          </div>

          {playlist && (
            <div className="queue-section">
              <button
                className="queue-toggle"
                onClick={() => setShowQueue((s) => !s)}
                aria-expanded={showQueue}
              >
                <span>
                  {showQueue ? "Hide playlist" : "Show playlist"} &middot; {playlist.tracks.length} tracks
                </span>
                <ChevronIcon open={showQueue} />
              </button>

              <div className={`queue-list custom-scrollbar ${showQueue ? "is-open" : ""}`}>
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
        </>
      )}

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
    </div>
  );
}

