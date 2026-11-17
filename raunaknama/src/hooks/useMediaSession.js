import { useEffect, useRef } from "react";
import { audioEngine } from "../lib/audioEngine";
import {
  nativeMediaSessionInit,
  nativeSetMetadata,
  nativeSetPlaybackState,
  nativeSetPositionState,
  nativeAddMediaButtonListeners,
} from "../lib/nativeMediaSession";

// Complete navigator.mediaSession integration, bound to whichever <audio> element the
// engine currently has active (primary <-> standby swap transparently).
//
//  - metadata (title / artist / album "RaunakNama" / artwork 96,192,512) on every track change
//  - playbackState driven by the elements' own play / pause events; never "none", and the
//    pause that precedes a natural "ended" is ignored so a track hand-over never flickers
//  - all action handlers registered ONCE (they read the latest callbacks through refs)
//  - setPositionState on timeupdate so the lock-screen seek bar moves
//  - same events mirrored to the Android native notification (no-op on plain web)

const ARTWORK_SIZES = ["96x96", "192x192", "512x512"];
const ICONS = [
  { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
];

const absolute = (src) => {
  try { return new URL(src, window.location.origin).href; } catch { return null; }
};

const squareCache = new Map();
const makeSquareArtwork = (url, size = 512) => {
  if (squareCache.has(url)) return squareCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      try {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        if (!side) return resolve(null);
        const c = document.createElement("canvas");
        c.width = size; c.height = size;
        c.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
        resolve(c.toDataURL("image/jpeg", 0.85));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  squareCache.set(url, p);
  return p;
};

const msSupported = () => typeof navigator !== "undefined" && "mediaSession" in navigator;

const setState = (state) => {
  if (msSupported()) {
    try { navigator.mediaSession.playbackState = state; } catch { /* ignore */ }
  }
  nativeSetPlaybackState(state === "playing");
};

const reportPosition = (audio) => {
  if (!audio) return;
  const duration = audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const position = Math.min(Math.max(audio.currentTime || 0, 0), duration);
  const playbackRate = audio.playbackRate > 0 ? audio.playbackRate : 1;
  if (msSupported()) {
    try { navigator.mediaSession.setPositionState({ duration, playbackRate, position }); } catch { /* ignore */ }
  }
  nativeSetPositionState(duration, position, playbackRate);
};

/**
 * @param track      { id, title, artist, artworkUrl } | null
 * @param isPlaying  the listener's intent (keeps the card "playing" through track transitions)
 * @param actions    { onNext, onPrevious } — read through a ref, may change every render
 */
export default function useMediaSession({ track, isPlaying, actions }) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const trackIdRef = useRef(null);
  trackIdRef.current = track?.id || null;

  // ---- 1. metadata: every time the track changes ----
  useEffect(() => {
    nativeMediaSessionInit();
  }, []);

  useEffect(() => {
    if (!track?.id) return;
    const title = track.title || "RaunakNama";
    const artist = track.artist || "RaunakNama";
    const art = track.artworkUrl ? absolute(track.artworkUrl) : null;

    if (msSupported() && typeof window.MediaMetadata === "function") {
      const publish = (src) => {
        const artwork = src
          ? [...ARTWORK_SIZES.map((sizes) => ({ src, sizes, type: "image/jpeg" })), ...ICONS.map((i) => ({ ...i, src: absolute(i.src) }))]
          : ICONS.map((i) => ({ ...i, src: absolute(i.src) }));
        try {
          navigator.mediaSession.metadata = new window.MediaMetadata({ title, artist, album: "RaunakNama", artwork });
        } catch { /* ignore */ }
      };
      publish(art); // immediately, plain https image
      if (art) {
        const wanted = track.id;
        makeSquareArtwork(art).then((sq) => {
          if (sq && trackIdRef.current === wanted) publish(sq); // upgrade to a true square crop
        });
      }
    }
    nativeSetMetadata({
      title, artist, album: "RaunakNama",
      artworkUrl: art || absolute("/icon-512.png"),
    });
    // a new track must never leave the card in "none"
    if (isPlaying) setState("playing");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, track?.title, track?.artist, track?.artworkUrl]);

  // ---- 2. playback intent (covers loading gaps) ----
  useEffect(() => {
    if (!track?.id) return;
    if (isPlaying) setState("playing");
    else {
      const a = audioEngine.getActive();
      if (a && a.paused) setState("paused");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // ---- 3. element events -> playbackState + position (bound to the ACTIVE element) ----
  useEffect(() => {
    let lastPos = 0;
    return audioEngine.subscribe((type, e, isActive) => {
      if (!isActive) return;
      const el = e.target;
      switch (type) {
        case "play":
        case "playing":
          setState("playing");
          reportPosition(el);
          break;
        case "pause":
          if (!el.ended) { setState("paused"); reportPosition(el); }
          break;
        case "timeupdate": {
          const now = Date.now();
          if (now - lastPos > 900) { lastPos = now; reportPosition(el); }
          break;
        }
        case "loadedmetadata":
        case "durationchange":
        case "seeked":
        case "ratechange":
          reportPosition(el);
          break;
        default:
      }
    });
  }, []);

  // ---- 4. action handlers: registered once ----
  useEffect(() => {
    const active = () => audioEngine.getActive();
    const play = () => { const a = active(); if (a) a.play().catch(() => {}); };
    const pause = () => { const a = active(); if (a) a.pause(); };
    const seekTo = (t) => {
      const a = active();
      if (!a || t == null || !Number.isFinite(t)) return;
      a.currentTime = Math.max(0, Math.min(t, Number.isFinite(a.duration) ? a.duration : t));
      reportPosition(a);
    };
    const seekBy = (d) => { const a = active(); if (a) seekTo((a.currentTime || 0) + d); };

    const handlers = {
      play,
      pause,
      stop: pause,
      previoustrack: () => actionsRef.current?.onPrevious?.(),
      nexttrack: () => actionsRef.current?.onNext?.(),
      seekto: (d) => seekTo(d?.seekTime),
      seekbackward: (d) => seekBy(-(d?.seekOffset || 10)),
      seekforward: (d) => seekBy(d?.seekOffset || 10),
    };
    if (msSupported()) {
      Object.entries(handlers).forEach(([name, fn]) => {
        try { navigator.mediaSession.setActionHandler(name, fn); } catch { /* unsupported action */ }
      });
    }
    const removeNative = nativeAddMediaButtonListeners({
      onPlay: play,
      onPause: pause,
      onNext: handlers.nexttrack,
      onPrevious: handlers.previoustrack,
      onSeek: seekTo,
    });
    return () => {
      removeNative();
      if (msSupported()) {
        Object.keys(handlers).forEach((name) => {
          try { navigator.mediaSession.setActionHandler(name, null); } catch { /* ignore */ }
        });
      }
    };
  }, []);
}
