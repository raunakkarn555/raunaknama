import { useCallback, useEffect, useRef, useState } from "react";
import "./ArtistPage.css";
import { warmStream } from "../streamClient";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

const initials = (name) =>
  String(name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || "")
    .join("");

/** Round artist photo with an initials fallback (photo missing or failed to load). */
export function ArtistAvatar({ artist, className = "" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [artist?.image]);
  return (
    <span className={`ar-avatar ${className}`}>
      {artist?.image && !failed ? (
        <img
          src={artist.image}
          alt={artist.name}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="ar-avatar-fallback" aria-hidden="true">{initials(artist?.name)}</span>
      )}
    </span>
  );
}

/** Card shown on the search page when the query is an artist's name. */
export function ArtistSearchCard({ artist, onOpen }) {
  return (
    <button type="button" className="ar-card" onClick={() => onOpen(artist)} aria-label={`Open artist page for ${artist.name}`}>
      <ArtistAvatar artist={artist} className="ar-avatar--card" />
      <span className="ar-card-meta">
        <span className="ar-card-kind">Artist</span>
        <span className="ar-card-name">{artist.name}</span>
        {artist.description && <span className="ar-card-desc">{artist.description}</span>}
      </span>
      <span className="ar-card-chevron" aria-hidden="true">›</span>
    </button>
  );
}

/**
 * Full-screen artist page: photo, about, and an endless list of songs that
 * keeps loading as you scroll. `renderTrack` is the host's song card so
 * play / like / add-to-playlist behave exactly like in search.
 */
export default function ArtistPage({ artist, onClose, renderTrack, onPlay }) {
  const [songs, setSongs] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | error | end
  const [aboutOpen, setAboutOpen] = useState(false);

  const pageRef = useRef(0);
  const busyRef = useRef(false);
  const seenRef = useRef(new Set());
  const emptyRunRef = useRef(0);
  const bodyRef = useRef(null);
  const sentinelRef = useRef(null);
  const nameRef = useRef(artist.name);

  const loadMore = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setStatus("loading");
    const name = nameRef.current;
    try {
      // Skip over pages that add nothing new (all duplicates / filtered out).
      for (let tries = 0; tries < 3; tries++) {
        const page = pageRef.current;
        const res = await fetch(`${API_BASE}/api/artist-songs?name=${encodeURIComponent(name)}&page=${page}`);
        const data = await res.json().catch(() => ({}));
        if (nameRef.current !== name) return; // artist changed while loading
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

        pageRef.current = page + 1;
        const fresh = (data.results || []).filter((t) => t?.id && !seenRef.current.has(t.id));
        fresh.forEach((t) => seenRef.current.add(t.id));

        if (fresh.length) {
          emptyRunRef.current = 0;
          setSongs((prev) => prev.concat(fresh));
          if (page === 0) fresh.slice(0, 3).forEach((t, i) => setTimeout(() => warmStream(t.id), i * 300));
        } else {
          emptyRunRef.current += 1;
        }

        if (!data.hasMore) {
          setStatus("end");
          return;
        }
        if (fresh.length) {
          setStatus("idle");
          return;
        }
      }
      setStatus("idle");
    } catch (err) {
      console.warn("Artist songs error:", err.message);
      setStatus("error");
    } finally {
      busyRef.current = false;
    }
  }, []);

  // First page immediately.
  useEffect(() => {
    loadMore();
  }, [loadMore]);

  // Infinite scroll: load the next page when the sentinel nears the viewport.
  useEffect(() => {
    const root = bodyRef.current;
    const el = sentinelRef.current;
    if (!root || !el || status !== "idle") return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { root, rootMargin: "600px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [status, songs.length, loadMore]);

  const about = artist.about || "";
  const longAbout = about.length > 280;

  return (
    <div className="ap-page" role="dialog" aria-modal="true" aria-label={`${artist.name} — artist page`}>
      <div className="ap-top">
        <button type="button" className="sp-back" onClick={onClose} aria-label="Back">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <span className="ap-top-title">{artist.name}</span>
      </div>

      <div className="ap-body custom-scrollbar" ref={bodyRef}>
        <header className="ap-hero">
          {artist.image && <span className="ap-hero-bg" style={{ backgroundImage: `url(${artist.image})` }} aria-hidden="true" />}
          <ArtistAvatar artist={artist} className="ar-avatar--hero" />
          <div className="ap-hero-text">
            <span className="ap-kind">Artist</span>
            <h1 className="ap-name">{artist.name}</h1>
            {artist.description && <p className="ap-desc">{artist.description}</p>}
            <div className="ap-hero-actions">
              <button
                type="button"
                className="ap-play"
                disabled={!songs.length}
                onClick={() => songs[0] && onPlay?.(songs[0])}
              >
                ▶ Play
              </button>
            </div>
          </div>
        </header>

        {about && (
          <section className="ap-about" aria-labelledby="ap-about-h">
            <h2 id="ap-about-h" className="sp-heading">About</h2>
            <p className={`ap-about-text ${longAbout && !aboutOpen ? "is-clamped" : ""}`}>{about}</p>
            {longAbout && (
              <button type="button" className="ap-more" onClick={() => setAboutOpen((v) => !v)}>
                {aboutOpen ? "Show less" : "Read more"}
              </button>
            )}
            {artist.url && (
              <a className="ap-source" href={artist.url} target="_blank" rel="noopener noreferrer">
                Source: Wikipedia
              </a>
            )}
          </section>
        )}

        <h2 className="sp-heading">Songs</h2>
        <div className="sp-grid">{songs.map((t) => renderTrack(t))}</div>

        {status === "loading" && (
          <div className="sp-grid ap-skels" aria-hidden="true">
            {Array.from({ length: songs.length ? 4 : 8 }, (_, i) => <div key={i} className="sp-card sp-skel" />)}
          </div>
        )}
        {status === "error" && (
          <p className="ap-note">
            Couldn’t load songs right now.{" "}
            <button type="button" className="ap-more" onClick={loadMore}>Try again</button>
          </p>
        )}
        {status === "end" && songs.length > 0 && <p className="ap-note">That’s everything for now.</p>}
        {status === "end" && songs.length === 0 && <p className="ap-note">No songs found for this artist.</p>}

        <div ref={sentinelRef} className="ap-sentinel" aria-hidden="true" />
      </div>
    </div>
  );
}
