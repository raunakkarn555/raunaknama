import React, { useEffect, useMemo, useState } from "react";
import Icon from "./Icon";
import "./SearchHistory.css";

// Search history (kept ONLY in this browser's localStorage) + suggestions for the search page.

const KEY = "raunaknama.searchHistory.v1";
const MAX = 12;
const POPULAR = [
  "Arijit Singh", "Kishore Kumar", "Lata Mangeshkar", "Mohammed Rafi", "Kumar Sanu", "Udit Narayan", "Alka Yagnik", "Atif Aslam",
  "Shreya Ghoshal", "Sonu Nigam", "Jubin Nautiyal", "A R Rahman", "Nusrat Fateh Ali Khan", "Rahat Fateh Ali Khan", "KK", "Lucky Ali",
  "Tum Hi Ho", "Kabira", "Channa Mereya", "Kesariya", "Tujhe Dekha To", "Pehla Nasha", "Chaiyya Chaiyya", "Kal Ho Naa Ho",
  "Tere Bina", "Agar Tum Saath Ho", "Raabta", "Phir Le Aaya Dil", "Ae Dil Hai Mushkil", "Lag Ja Gale", "Yeh Dosti", "Mere Sapno Ki Rani",
  "Ek Ladki Ko Dekha To", "Dil Diyan Gallan", "Bekhayali", "Tera Ban Jaunga", "Hawayein", "Zara Zara", "Kun Faya Kun", "Mera Mann",
  "90s bollywood songs", "old hindi songs", "sad songs hindi", "punjabi songs", "bollywood party songs", "lofi hindi",
];

const read = () => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && x.trim()).slice(0, MAX) : [];
  } catch { return []; }
};
const write = (list) => { try { window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* ignore */ } };

/** Adds a query to the top of the history (case-insensitive de-dupe). Safe to call from anywhere. */
export function saveSearchQuery(q) {
  const t = String(q || "").trim().replace(/\s+/g, " ");
  if (t.length < 2) return;
  const list = read().filter((x) => x.toLowerCase() !== t.toLowerCase());
  list.unshift(t);
  write(list);
  try { window.dispatchEvent(new Event("rn-search-history")); } catch { /* ignore */ }
}

export default function SearchHistory({ query, onPick }) {
  const [history, setHistory] = useState(read);
  useEffect(() => {
    const sync = () => setHistory(read());
    window.addEventListener("rn-search-history", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("rn-search-history", sync); window.removeEventListener("storage", sync); };
  }, []);

  // A search you leave on screen for a moment counts as "searched" -> goes into history.
  useEffect(() => {
    const t = String(query || "").trim();
    if (t.length < 3) return undefined;
    const id = setTimeout(() => saveSearchQuery(t), 1600);
    return () => clearTimeout(id);
  }, [query]);

  const remove = (q) => { const next = history.filter((x) => x !== q); setHistory(next); write(next); };
  const clearAll = () => { setHistory([]); write([]); };

  const q = String(query || "").trim().toLowerCase();
  const suggestions = useMemo(() => {
    if (!q) return [];
    const seen = new Set();
    const out = [];
    const add = (text, kind) => {
      const k = text.toLowerCase();
      if (k === q || seen.has(k)) return;
      seen.add(k); out.push({ text, kind });
    };
    history.filter((h) => h.toLowerCase().includes(q)).forEach((h) => add(h, "history"));
    POPULAR.filter((p) => p.toLowerCase().startsWith(q)).forEach((p) => add(p, "suggest"));
    POPULAR.filter((p) => p.toLowerCase().includes(q)).forEach((p) => add(p, "suggest"));
    return out.slice(0, 7);
  }, [q, history]);

  if (q) {
    if (!suggestions.length) return null;
    return (
      <div className="sh-wrap" aria-label="Search suggestions">
        <ul className="sh-list">
          {suggestions.map((s) => (
            <li key={`${s.kind}-${s.text}`} className="sh-row">
              <button type="button" className="sh-pick" onClick={() => onPick(s.text)}>
                <span className="sh-ico" aria-hidden="true">{s.kind === "history" ? <HistoryIcon /> : <Icon name="search" />}</span>
                <span className="sh-text">{s.text}</span>
              </button>
              {s.kind === "history" && (
                <button type="button" className="sh-x" onClick={() => remove(s.text)} aria-label={`Remove ${s.text} from history`}>&times;</button>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const popular = POPULAR.slice(0, 16).filter((p) => !history.some((h) => h.toLowerCase() === p.toLowerCase())).slice(0, 12);
  return (
    <div className="sh-wrap">
      {history.length > 0 && (
        <section aria-label="Recent searches">
          <div className="sh-head">
            <h2 className="sh-title">Recent searches</h2>
            <button type="button" className="sh-clear" onClick={clearAll}>Clear all</button>
          </div>
          <ul className="sh-list">
            {history.map((h) => (
              <li key={h} className="sh-row">
                <button type="button" className="sh-pick" onClick={() => onPick(h)}>
                  <span className="sh-ico" aria-hidden="true"><HistoryIcon /></span>
                  <span className="sh-text">{h}</span>
                </button>
                <button type="button" className="sh-x" onClick={() => remove(h)} aria-label={`Remove ${h} from history`}>&times;</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Suggestions">
        <div className="sh-head"><h2 className="sh-title">Try searching</h2></div>
        <div className="sh-chips">
          {popular.map((p) => (
            <button key={p} type="button" className="sh-chip" onClick={() => onPick(p)}>{p}</button>
          ))}
        </div>
      </section>
    </div>
  );
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" />
    </svg>
  );
}
