import { useEffect, useRef, useState } from "react";
import "./MediaGrid.css";
import Icon from "./Icon";

export default function MediaGrid({ endpoint = "/api/media-grid" }) {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [activeId, setActiveId] = useState(null);
  const [playState, setPlayState] = useState("idle"); // idle | loading | playing | error
  const audioRef = useRef(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(endpoint, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((d) => {
        setItems(Array.isArray(d.items) ? d.items : []);
        setStatus("ready");
      })
      .catch((e) => e.name !== "AbortError" && setStatus("error"));
    return () => ctrl.abort();
  }, [endpoint]);

  const toggle = async (item) => {
    const audio = audioRef.current;
    if (!audio) return;

    if (activeId === item.id && playState === "playing") {
      audio.pause();
      setPlayState("idle");
      return;
    }
    setActiveId(item.id);
    setPlayState("loading");
    // The browser follows the endpoint's 302 and streams with Range requests.
    audio.src = `/api/stream?token=${encodeURIComponent(item.id)}`;
    try {
      await audio.play();
      setPlayState("playing");
    } catch {
      setPlayState("error");
    }
  };

  if (status === "loading") return <p className="mg-note">Loading…</p>;
  if (status === "error") return <p className="mg-note">Couldn’t load the grid.</p>;

  return (
    <section className="mg-wrap">
      <audio
        ref={audioRef}
        onEnded={() => setPlayState("idle")}
        onError={() => setPlayState("error")}
      />
      <ul className="mg-grid">
        {items.map((item) => {
          const active = item.id === activeId;
          const state = active ? playState : "idle";
          return (
            <li key={item.id} className="mg-card" data-state={state}>
              <div className="mg-art">
                {item.thumbnailUrl ? (
                  <img src={item.thumbnailUrl} alt="" loading="lazy" decoding="async" />
                ) : (
                  <div className="mg-art-fallback" aria-hidden="true"><Icon name="music" /></div>
                )}
                {item.duration && <span className="mg-duration">{item.duration}</span>}
                <button
                  type="button"
                  className="mg-play"
                  onClick={() => toggle(item)}
                  aria-label={`${state === "playing" ? "Pause" : "Play"} ${item.title}`}
                >
                  {state === "loading" ? "…" : state === "playing" ? <Icon name="pause" /> : <Icon name="play" />}
                </button>
              </div>
              <div className="mg-meta">
                <h3 className="mg-title" title={item.title}>{item.title}</h3>
                <p className="mg-sub" title={item.subtitle}>{item.subtitle}</p>
                {state === "error" && <p className="mg-err">Playback failed</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
