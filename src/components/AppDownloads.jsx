import React, { useMemo, useState } from "react";
import Icon from "./Icon";
import "./AppDownloads.css";

// The native apps live on GitHub Releases (keeps this site light).
export const RELEASE_URL = "https://github.com/raunakkarn555/raunaknama-music/releases/tag/v4";

const detectPlatform = () => {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  if (/android/i.test(ua)) return "android";
  if (/windows/i.test(ua)) return "windows";
  return "other";
};

const STEPS = {
  windows: [
    "Download button dabao, GitHub ka Releases page khulega.",
    "Neeche \"Assets\" me .exe file chuno: Setup = install hoga, Portable = bina install ke seedha chalega.",
    "File download hone ke baad us par double-click karo.",
    "Windows \"protected your PC\" dikhaye to More info, phir Run anyway dabao (app signed nahi hai).",
    "Setup me Next dabate jao. Install ke baad Raunaknama ka icon Desktop / Start menu me aa jayega.",
  ],
  android: [
    "Download button dabao, GitHub ka Releases page khulega.",
    "Neeche \"Assets\" me .apk file par tap karo, download shuru ho jayega.",
    "Download hone par file kholo (notification ya Files > Downloads).",
    "\"Install unknown apps\" ka option aaye to Settings me jakar apne browser ke liye allow karo.",
    "Install dabao, phir Open. Ho gaya.",
  ],
};

export default function AppDownloads() {
  const platform = useMemo(detectPlatform, []);
  const [tab, setTab] = useState(platform === "android" ? "android" : "windows");
  const [open, setOpen] = useState(false);

  return (
    <div className="drawer-section apd-card">
      <div className="apd-head">
        <span className="apd-badge" aria-hidden="true"><Icon name="download" /></span>
        <div>
          <p className="apd-title">Get the app</p>
          <p className="apd-lead">Laptop aur phone dono ke liye.</p>
        </div>
      </div>

      <div className="apd-row-btns">
        <a className="apd-btn apd-btn--primary" href={RELEASE_URL} target="_blank" rel="noopener noreferrer">
          <Icon name="monitor" /> Windows
        </a>
        <a className="apd-btn apd-btn--primary" href={RELEASE_URL} target="_blank" rel="noopener noreferrer">
          <Icon name="phone" /> Android
        </a>
      </div>
      <p className="apd-sub">Download GitHub Releases se hota hai (v4).</p>

      <button
        type="button"
        className="apd-how"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>Kaise download &amp; install karein?</span>
        <Icon name="arrowRight" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .2s" }} />
      </button>

      {open && (
        <div className="apd-guide">
          <div className="apd-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "windows"} className={`apd-tab ${tab === "windows" ? "is-active" : ""}`} onClick={() => setTab("windows")}>
              <Icon name="monitor" /> Windows
            </button>
            <button type="button" role="tab" aria-selected={tab === "android"} className={`apd-tab ${tab === "android" ? "is-active" : ""}`} onClick={() => setTab("android")}>
              <Icon name="phone" /> Android
            </button>
          </div>
          <ol className="apd-steps">
            {STEPS[tab].map((t, i) => (
              <li key={i}><span className="apd-step-n">{i + 1}</span><span>{t}</span></li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
