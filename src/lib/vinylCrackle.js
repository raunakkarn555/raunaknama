// Soft vinyl "crackle" bed (hiss + random pops) generated with the Web Audio API.
// It plays on its OWN AudioContext, completely separate from the song, so the real audio path is never touched.

const KEY = "raunaknama.vinylCrackle.v1";
export const loadCrackle = () => { try { return window.localStorage.getItem(KEY) === "1"; } catch { return false; } };
export const saveCrackle = (on) => { try { window.localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* ignore */ } };

let ctx = null;
let gain = null;
let src = null;

function makeBuffer(c) {
  const secs = 4;
  const len = Math.floor(c.sampleRate * secs);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { // brown-ish hiss
    last = (last + (Math.random() * 2 - 1) * 0.02) * 0.985;
    d[i] = last * 0.35;
  }
  const pops = Math.floor(secs * 14); // ~14 pops a second
  for (let p = 0; p < pops; p++) {
    const at = Math.floor(Math.random() * (len - 400));
    const amp = (Math.random() < 0.12 ? 0.55 : 0.12) * (0.4 + Math.random() * 0.6);
    const dur = 8 + Math.floor(Math.random() * 90);
    const sign = Math.random() < 0.5 ? -1 : 1;
    for (let k = 0; k < dur; k++) d[at + k] += sign * amp * Math.exp(-k / (dur * 0.28)) * (Math.random() * 0.6 + 0.4);
  }
  return buf;
}

export function startCrackle() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      gain = ctx.createGain();
      gain.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 7000;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass"; hp.frequency.value = 400;
      gain.connect(lp); lp.connect(hp); hp.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    if (!src) {
      src = ctx.createBufferSource();
      src.buffer = makeBuffer(ctx);
      src.loop = true;
      src.connect(gain);
      src.start();
    }
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 0.6);
  } catch { /* ignore */ }
}

export function stopCrackle() {
  try {
    if (!ctx || !gain) return;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.35);
    const s = src;
    src = null;
    setTimeout(() => { try { s && s.stop(); } catch { /* ignore */ } }, 450);
  } catch { /* ignore */ }
}
