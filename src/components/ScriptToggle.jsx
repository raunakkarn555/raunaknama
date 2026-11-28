import React from "react";
import { SCRIPT_MODES } from "../lib/script";
import "./ScriptToggle.css";

// Roman / Devanagari / Urdu switch for lyrics. "Original" shows the lyrics exactly as fetched.
export default function ScriptToggle({ mode, onChange, disabled = false, className = "" }) {
  return (
    <div className={`script-toggle ${className}`.trim()} role="radiogroup" aria-label="Lyrics script" title="Lyrics ki script badlo (Roman / Devanagari / Urdu)">
      {SCRIPT_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={mode === m.id}
          disabled={disabled}
          className={`script-toggle-btn ${mode === m.id ? "is-active" : ""}`}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
