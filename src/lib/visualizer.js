// Beat-reactive audio visualizer (bars / wave) for the full player view.
//
// It LISTENS to the song through element.captureStream(), which never changes what you hear (unlike
// createMediaElementSource, which would mute cross-origin streams). If the browser cannot expose the
// signal (Safari, YouTube-player fallback, cross-origin stream) it falls back to a beat-clock animation
// so the bars still dance in time with playback.

import audioEngine from "./audioEngine";

const KEY = "raunaknama.visualizer.v1";
export const VIZ_MODES = ["bars", "wave", "off"];
export const loadVizMode = () => { try { const v = window.localStorage.getItem(KEY); return VIZ_MODES.includes(v) ? v : "bars"; } catch { return "bars"; } };
export const saveVizMode = (m) => { try { window.localStorage.setItem(KEY, m); } catch { /* ignore */ } };

export function createVisualizer(canvas, getState) {
  // getState() -> { mode: "bars"|"wave"|"off", playing: boolean }
  const g = canvas.getContext("2d");
  let raf = 0;
  let ctx = null;
  let analyser = null;
  let srcNode = null;
  let srcEl = null;
  let freq = null;
  let time = null;
  let w = 0; let h = 0; let dpr = 1;
  const BARS = 44;
  const level = new Float32Array(BARS);
  let beat = 0; let bassAvg = 0; let lastBeat = 0;
  let realFrames = 0; let silentFrames = 0; let useReal = false; let checkedAt = 0;
  let simPhase = 0;
  let alive = true;

  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    w = Math.max(1, Math.floor(r.width)); h = Math.max(1, Math.floor(r.height));
    canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  resize();

  const attach = () => {
    try {
      if (audioEngine.isYt()) { detach(); return; }
      const el = audioEngine.getActive();
      if (!el || el === srcEl) return;
      detach();
      const cap = el.captureStream || el.mozCaptureStream;
      if (!cap) return;
      const stream = cap.call(el);
      if (!stream.getAudioTracks || !stream.getAudioTracks().length) { srcEl = null; return; } // tracks appear once the element plays; retry
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ctx) ctx = new AC();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.78;
      srcNode = ctx.createMediaStreamSource(stream);
      srcNode.connect(analyser); // NOT connected to destination: the song keeps playing through the normal path
      freq = new Uint8Array(analyser.frequencyBinCount);
      time = new Uint8Array(analyser.fftSize);
      srcEl = el;
      realFrames = 0; silentFrames = 0; useReal = false;
    } catch { detach(); }
  };
  const detach = () => {
    try { srcNode && srcNode.disconnect(); } catch { /* ignore */ }
    srcNode = null; analyser = null; srcEl = null; freq = null; time = null; useReal = false;
  };

  const accent = () => {
    const cs = getComputedStyle(canvas);
    return {
      a: (cs.getPropertyValue("--track-accent") || "").trim() || "#b8333a",
      b: (cs.getPropertyValue("--track-accent-soft") || "").trim() || "#e2ab3f",
    };
  };

  const frame = (now) => {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const st = getState();
    g.clearRect(0, 0, w, h);
    if (st.mode === "off") return;
    if (document.hidden) { if (srcNode) detach(); try { if (ctx && ctx.state === "running") ctx.suspend(); } catch { /* ignore */ } return; } // never keep the song's stream captured while the tab is in the background
    if (now - checkedAt > 700) { checkedAt = now; attach(); }

    // ---- read the signal (real or simulated) ----
    let bass = 0;
    const bins = new Float32Array(BARS);
    let gotReal = false;
    if (analyser && st.playing) {
      analyser.getByteFrequencyData(freq);
      analyser.getByteTimeDomainData(time);
      let sum = 0;
      for (let i = 0; i < freq.length; i++) sum += freq[i];
      if (sum > 40) { realFrames++; silentFrames = 0; } else silentFrames++;
      if (realFrames > 6) useReal = true;
      if (silentFrames > 90) useReal = false; // ~1.5 s of nothing while "playing" => cross-origin / unreadable stream
      gotReal = useReal && sum > 0;
      if (gotReal) {
        const usable = Math.floor(freq.length * 0.62);
        for (let i = 0; i < BARS; i++) {
          const a = Math.floor(Math.pow(i / BARS, 1.6) * usable);
          const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / BARS, 1.6) * usable));
          let m = 0; for (let k = a; k < b; k++) m = Math.max(m, freq[k]);
          bins[i] = m / 255;
        }
        let bs = 0; for (let i = 1; i < 6; i++) bs += freq[i];
        bass = bs / (5 * 255);
      }
    }
    if (!gotReal) {
      if (st.playing) {
        simPhase += 0.016;
        const bpm = 108; const per = 60 / bpm;
        const ph = (simPhase % per) / per;
        const kick = Math.pow(Math.max(0, 1 - ph * 3), 2); // sharp attack, quick decay
        bass = 0.35 + kick * 0.55;
        for (let i = 0; i < BARS; i++) {
          const f = 1 - i / BARS;
          const wob = 0.5 + 0.5 * Math.sin(simPhase * (2.2 + (i % 7) * 0.35) + i * 1.7);
          bins[i] = Math.min(1, (0.12 + f * 0.5 * (0.45 + 0.55 * wob) + kick * f * 0.5));
        }
      }
    }
    // ---- beat detection (bass jump over its running average) ----
    bassAvg = bassAvg * 0.94 + bass * 0.06;
    if (bass > bassAvg * 1.18 + 0.04 && now - lastBeat > 180) { beat = 1; lastBeat = now; }
    beat *= 0.9;

    for (let i = 0; i < BARS; i++) {
      const target = st.playing ? bins[i] : 0;
      level[i] += (target - level[i]) * (target > level[i] ? 0.55 : 0.12);
    }

    // ---- draw ----
    const col = accent();
    const grad = g.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, col.a); grad.addColorStop(1, col.b);
    g.fillStyle = grad; g.strokeStyle = grad;
    g.shadowColor = col.b; g.shadowBlur = 8 + beat * 18;
    g.globalAlpha = 0.5 + beat * 0.4;

    if (st.mode === "bars") {
      const gap = Math.max(2, w / BARS * 0.28);
      const bw = (w - gap * (BARS - 1)) / BARS;
      for (let i = 0; i < BARS; i++) {
        const v = Math.min(1, level[i] * (1 + beat * 0.25));
        const bh = Math.max(3, v * h * 0.95);
        const x = i * (bw + gap);
        const r = Math.min(bw / 2, 4);
        g.beginPath();
        g.moveTo(x, h); g.lineTo(x, h - bh + r); g.quadraticCurveTo(x, h - bh, x + r, h - bh);
        g.lineTo(x + bw - r, h - bh); g.quadraticCurveTo(x + bw, h - bh, x + bw, h - bh + r); g.lineTo(x + bw, h);
        g.closePath(); g.fill();
      }
    } else {
      // wave: smooth curve through the band levels, mirrored, with a soft fill beneath
      const mid = h * 0.62;
      const pts = [];
      for (let i = 0; i < BARS; i++) pts.push([(i / (BARS - 1)) * w, mid - Math.min(1, level[i] * (1 + beat * 0.3)) * h * 0.55]);
      const path = () => {
        g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i++) {
          const cx = (pts[i][0] + pts[i + 1][0]) / 2; const cy = (pts[i][1] + pts[i + 1][1]) / 2;
          g.quadraticCurveTo(pts[i][0], pts[i][1], cx, cy);
        }
        g.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      };
      g.lineWidth = 2.5; g.lineJoin = "round"; g.lineCap = "round";
      path(); g.stroke();
      g.globalAlpha *= 0.28; path(); g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fill();
    }
    g.globalAlpha = 1; g.shadowBlur = 0;
  };
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      alive = false; cancelAnimationFrame(raf); ro?.disconnect(); detach();
      try { ctx && ctx.close(); } catch { /* ignore */ }
    },
  };
}
