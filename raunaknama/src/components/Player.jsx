import React, { useEffect, useState, useRef } from "react";
import "./Player.css";

// In production, set VITE_API_BASE_URL to your deployed backend's URL
// (e.g. https://raunaknama-server.onrender.com). Locally it falls back to
// the same localhost:5000 as before, so nothing changes for local dev.
const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

const formatTime = (secs) => {
  if (!secs || Number.isNaN(secs) || !Number.isFinite(secs)) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
};

// Fisher–Yates shuffle of track indices
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

export default function Player() {
  // ---- Core playback state (kept the same shape/behaviour as before) ----
  const [playlist, setPlaylist] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ---- Multi-playlist selection ----
  const [playlists, setPlaylists] = useState([]);
  const [activePlaylistId, setActivePlaylistId] = useState(null);

  // ---- Shuffle ----
  const [shuffle, setShuffle] = useState(false);
  const [shuffleOrder, setShuffleOrder] = useState([]);

  // ---- Search-any-song ----
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchTrack, setSearchTrack] = useState(null);
  const [activeSource, setActiveSource] = useState("playlist"); // "playlist" | "search"

  // ---- Seek / volume / queue visibility (UI-only) ----
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [showQueue, setShowQueue] = useState(false); // hidden by default on every device until opted in

  const audioRef = useRef(null);

  // 0. Fetch the list of available playlists once
  useEffect(() => {
    fetch(`${API_BASE}/api/playlists`)
      .then((res) => res.json())
      .then((data) => {
        if (data.playlists && data.playlists.length > 0) {
          setPlaylists(data.playlists);
          setActivePlaylistId(data.playlists[0].id);
        }
      })
      .catch((err) => console.error("Playlists list fetch error:", err));
  }, []);

  // 1. Fetch Playlist Metadata from Express Backend (now scoped to the active playlist)
  useEffect(() => {
    if (!activePlaylistId) return;
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
        setError("Could not connect to streaming server on port 5000.");
        setLoading(false);
      });
  }, [activePlaylistId]);

  // Reset the seek display whenever the track changes (UI-only)
  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
  }, [currentIndex, searchTrack]);

  // Debounced live search — results appear as you type
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
  const streamUrl = currentTrack
    ? `${API_BASE}/api/stream?id=${currentTrack.id}`
    : "";

  // 2. Playback Controls
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
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      // play() returns a promise; if it rejects (e.g. the source hasn't
      // loaded yet, or a track-skip interrupted it) we swallow it here so
      // it doesn't surface as an "Uncaught (in promise)" console error.
      const playPromise = audioRef.current.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch((err) => {
          console.warn("Playback couldn't start:", err.message || err);
        });
      }
    }
  };

  // The native <audio autoPlay> also fires its own internal play() call
  // whenever `src` changes, which can reject the same way (unsupported
  // source, aborted by a fast track-skip, etc.). Surface that as a normal
  // error state instead of letting it become an unhandled rejection.
  const handleAudioError = () => {
    const mediaError = audioRef.current?.error;
    console.warn("Audio element error:", mediaError?.message || mediaError);
    setIsPlaying(false);
  };

  // Shuffle toggle — generates a fresh random order for the current playlist
  const toggleShuffle = () => {
    setShuffle((prev) => {
      const next = !prev;
      if (next && playlist) {
        setShuffleOrder(shuffledIndices(playlist.tracks.length));
      }
      return next;
    });
  };

  // Select a track directly from the visible queue
  const selectPlaylistTrack = (idx) => {
    setActiveSource("playlist");
    setCurrentIndex(idx);
  };

  // Play a track found via search, independent of any registered playlist
  const playSearchResult = (track) => {
    setSearchTrack(track);
    setActiveSource("search");
  };

  // UI-only helpers for the custom seek bar / volume slider
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

  const showResultsDropdown = searchFocused && (searchQuery.trim().length > 0);

  return (
    <div className="player-card">
      {/* ---------- Playlist tabs ---------- */}
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

      {/* ---------- Search any song ---------- */}
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
                  <span className="search-result-title line-clamp-2">{track.title}</span>
                  {track.channel && <span className="search-result-channel">{track.channel}</span>}
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
          <p className="state-hint">
            Make sure <code>node server.js</code> is running on port 5000.
          </p>
        </div>
      )}

      {!loading && !error && currentTrack && (
        <>
          <div className="player-card-header">
            <span className="eyebrow">
              {activeSource === "search" ? "Playing from search" : "Now Playing"}
            </span>
            <h2 className="playlist-title">
              {activeSource === "search" ? "Custom pick" : playlist?.playlistTitle}
            </h2>
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

            {/* Native audio element drives playback; UI is fully custom */}
            <audio
              ref={audioRef}
              src={streamUrl}
              autoPlay
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={activeSource === "search" ? () => setIsPlaying(false) : handleNext}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onError={handleAudioError}
              className="native-audio"
            />

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
              <span className="ctrl-spacer" aria-hidden="true" />
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
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
