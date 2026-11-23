// Instagram-style "like" burst: a big heart pops at the tap point and a ring
// of tiny hearts / sparks fly outward. Pure DOM + Web Animations API, no
// stylesheet needed, cleans itself up, and respects reduced-motion.

const HEART_PATH = "M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.7 4.5 6.3 4.5c2 0 3.5 1.1 4.2 2.3L12 8.6l1.5-1.8c.7-1.2 2.2-2.3 4.2-2.3 3.6 0 5.4 3.9 3.9 7.3C19.5 16.4 12 21 12 21Z";
const COLORS = ["#ff4d6d", "#ff7a93", "#e2ab3f", "#ff9f43", "#b8333a", "#ffd166"];

let last = { x: null, y: null, t: 0 };
let wired = false;

function wire() {
  if (wired || typeof document === "undefined") return;
  wired = true;
  const remember = (e) => {
    const t = e.touches?.[0] || e;
    if (typeof t.clientX === "number") last = { x: t.clientX, y: t.clientY, t: Date.now() };
  };
  document.addEventListener("pointerdown", remember, true);
  document.addEventListener("click", remember, true);
}
wire();

const heartSvg = (size, color) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${color}" style="display:block;filter:drop-shadow(0 2px 6px rgba(0,0,0,.45))"><path d="${HEART_PATH}"/></svg>`;

export function burstHearts(x, y) {
  if (typeof document === "undefined") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  // Fall back to the most recent tap/click position (keyboard use -> centre).
  if (typeof x !== "number" || typeof y !== "number") {
    const fresh = last.x != null && Date.now() - last.t < 1500;
    x = fresh ? last.x : window.innerWidth / 2;
    y = fresh ? last.y : window.innerHeight / 2;
  }

  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none;";
  document.body.appendChild(layer);

  const place = (html) => {
    const el = document.createElement("div");
    el.style.cssText = `position:absolute;left:${x}px;top:${y}px;will-change:transform,opacity;`;
    el.innerHTML = html;
    layer.appendChild(el);
    return el;
  };

  // Big centre pop.
  const big = place(heartSvg(54, "#ff4d6d"));
  big.animate(
    [
      { transform: "translate(-50%,-50%) scale(0.2)", opacity: 0 },
      { transform: "translate(-50%,-50%) scale(1.25)", opacity: 1, offset: 0.35 },
      { transform: "translate(-50%,-62%) scale(1)", opacity: 1, offset: 0.65 },
      { transform: "translate(-50%,-110%) scale(0.9)", opacity: 0 },
    ],
    { duration: 800, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }
  );

  // Ring of small hearts.
  const hearts = 9;
  for (let i = 0; i < hearts; i++) {
    const angle = (Math.PI * 2 * i) / hearts + (Math.random() - 0.5) * 0.5;
    const dist = 42 + Math.random() * 38;
    const size = 10 + Math.random() * 10;
    const color = COLORS[(Math.random() * COLORS.length) | 0];
    const el = place(heartSvg(size, color));
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 18; // slight upward drift
    const rot = (Math.random() - 0.5) * 80;
    el.animate(
      [
        { transform: "translate(-50%,-50%) scale(0.3) rotate(0deg)", opacity: 0 },
        { transform: `translate(calc(-50% + ${dx * 0.6}px), calc(-50% + ${dy * 0.6}px)) scale(1) rotate(${rot * 0.5}deg)`, opacity: 1, offset: 0.35 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 26}px)) scale(0.5) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: 650 + Math.random() * 300, easing: "cubic-bezier(.15,.7,.3,1)", fill: "forwards", delay: Math.random() * 60 }
    );
  }

  // Sparks.
  for (let i = 0; i < 8; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 30 + Math.random() * 46;
    const s = 3 + Math.random() * 3;
    const color = COLORS[(Math.random() * COLORS.length) | 0];
    const el = place(`<span style="display:block;width:${s}px;height:${s}px;border-radius:50%;background:${color}"></span>`);
    el.animate(
      [
        { transform: "translate(-50%,-50%) scale(1)", opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(0)`, opacity: 0 },
      ],
      { duration: 500 + Math.random() * 250, easing: "ease-out", fill: "forwards" }
    );
  }

  setTimeout(() => layer.remove(), 1300);
}
