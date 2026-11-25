// An <audio>-like wrapper around the YouTube IFrame Player.
//
// WHY: when the server can only obtain a stream that YouTube cuts after ~850 KB (bot / PO-token
// checks on the server's IP), the song dies ~50 s in. The YouTube player runs in the LISTENER'S OWN
// browser, so it is not affected: it starts in ~1-2 s and plays the full song.
//
// It exposes the subset of HTMLMediaElement the player uses (play/pause/currentTime/duration/
// volume/paused/ended/…) and reports state changes through `emit(type)` using the same event names
// the audio engine already understands.

let apiPromise = null;
function loadApi() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    let timer = null;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      try { if (typeof prev === "function") prev(); } catch { /* ignore */ }
      resolve(window.YT);
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    s.onerror = () => { apiPromise = null; clearTimeout(timer); reject(new Error("YouTube player script blocked")); };
    document.head.appendChild(s);
    timer = setTimeout(() => {
      if (!(window.YT && window.YT.Player)) { apiPromise = null; reject(new Error("YouTube player script timed out")); }
    }, 10000);
  });
  return apiPromise;
}

const START_TIMEOUT_MS = 12000;

export function createYtAudio(emit) {
  let player = null;
  let videoId = null;
  let state = -1; // YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
  let started = false;
  let pollTimer = null;
  let vol = 1;
  let muted = false;
  let errorObj = null;
  let pending = null; // { resolve, reject, timer, wantsPlay }
  let gen = 0;        // bumped on every start()/stop(): a superseded start must not keep playing

  const stopPoll = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
  const startPoll = () => { stopPoll(); pollTimer = setInterval(() => emit("timeupdate"), 250); };
  const settle = (ok, err) => {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    if (ok) p.resolve(); else p.reject(err || new Error("YouTube player failed"));
  };

  const onState = (e) => {
    state = e.data;
    switch (state) {
      case 3:
        emit("waiting");
        break;
      case 1:
        if (!started) { started = true; emit("loadedmetadata"); }
        emit("durationchange");
        emit("canplay");
        emit("play");
        emit("playing");
        startPoll();
        settle(true);
        break;
      case 2:
        stopPoll();
        if (started) emit("pause");
        break;
      case 0:
        stopPoll();
        emit("ended");
        break;
      case 5:
        emit("durationchange");
        emit("canplay");
        if (pending && !pending.wantsPlay) settle(true);
        break;
      default:
    }
  };
  const onError = (e) => {
    errorObj = { code: e?.data, message: `YouTube player error ${e?.data}` };
    stopPoll();
    if (pending) settle(false, new Error(errorObj.message));
    else emit("error");
  };

  const proxy = {
    isYt: true,
    get src() { return ""; },
    set src(_v) { /* ignored */ },
    getAttribute(name) { return name === "src" && videoId ? `yt:${videoId}` : null; },
    removeAttribute() {},
    load() {},
    canPlayType() { return ""; },
    get currentTime() { try { return player && started ? Number(player.getCurrentTime()) || 0 : 0; } catch { return 0; } },
    set currentTime(v) {
      try { if (player) { player.seekTo(Math.max(0, Number(v) || 0), true); emit("seeked"); emit("timeupdate"); } } catch { /* ignore */ }
    },
    get duration() { try { const d = player ? Number(player.getDuration()) : 0; return d > 0 ? d : NaN; } catch { return NaN; } },
    get paused() { return !(state === 1 || state === 3); },
    get ended() { return state === 0; },
    get readyState() { return started ? 4 : 0; },
    get error() { return errorObj; },
    get buffered() { return { length: 0, start: () => 0, end: () => 0 }; },
    get volume() { return vol; },
    set volume(v) { vol = Math.min(1, Math.max(0, Number(v) || 0)); try { if (player) player.setVolume(Math.round(vol * 100)); } catch { /* ignore */ } },
    get muted() { return muted; },
    set muted(m) { muted = !!m; try { if (player) { if (muted) player.mute(); else player.unMute(); } } catch { /* ignore */ } },
    loop: false,
    playbackRate: 1,
    play() { try { if (player) player.playVideo(); } catch { /* ignore */ } return Promise.resolve(); },
    pause() { try { if (player) player.pauseVideo(); } catch { /* ignore */ } },
  };

  function mount() {
    const host = document.createElement("div");
    host.id = "rn-yt-host";
    host.setAttribute("aria-hidden", "true");
    // Must stay "on screen" or the browser may throttle/pause it; invisible + untouchable.
    host.style.cssText = "position:fixed;right:0;bottom:0;width:200px;height:200px;opacity:0.01;pointer-events:none;z-index:-1;overflow:hidden;";
    const inner = document.createElement("div");
    host.appendChild(inner);
    document.body.appendChild(host);
    return inner;
  }

  async function start(id, { volume = 1, startAt = 0, autoplay = true } = {}) {
    const myGen = ++gen;
    const YT = await loadApi();
    if (myGen !== gen) throw new Error("superseded");
    videoId = id;
    started = false;
    state = -1;
    errorObj = null;
    vol = volume;
    stopPoll();
    settle(false, new Error("superseded"));

    const done = new Promise((resolve, reject) => {
      pending = {
        resolve,
        reject,
        wantsPlay: autoplay,
        timer: setTimeout(() => {
          // Autoplay blocked / still unstarted: leave it ready so the Play button works.
          if (state === 1 || state === 2 || state === 5 || state === -1) {
            if (state !== 1) emit("pause"); // autoplay was blocked: show Play, not Pause
            settle(true);
          }
          else settle(false, new Error("YouTube player timed out"));
        }, START_TIMEOUT_MS),
      };
    });

    done.catch(() => {}); // outcome is awaited below; avoid an unhandled-rejection warning when we bail out early

    if (!player) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("YouTube player init timed out")), START_TIMEOUT_MS);
        player = new YT.Player(mount(), {
          width: "200",
          height: "200",
          videoId: id,
          playerVars: {
            autoplay: autoplay ? 1 : 0,
            controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, modestbranding: 1,
            start: Math.floor(startAt) || 0,
            origin: typeof location !== "undefined" ? location.origin : undefined,
          },
          events: { onReady: () => { clearTimeout(t); resolve(); }, onStateChange: onState, onError },
        });
      }).catch((err) => { settle(false, err); throw err; });
      try { player.setVolume(Math.round(vol * 100)); } catch { /* ignore */ }
    } else {
      try {
        player.setVolume(Math.round(vol * 100));
        if (autoplay) player.loadVideoById({ videoId: id, startSeconds: startAt || 0 });
        else player.cueVideoById({ videoId: id, startSeconds: startAt || 0 });
      } catch (err) { settle(false, err); throw err; }
    }
    try {
      await done;
    } catch (err) {
      throw err;
    }
    if (myGen !== gen) { try { player.stopVideo(); } catch { /* ignore */ } throw new Error("superseded"); }
  }

  function stop() {
    gen += 1;
    stopPoll();
    settle(false, new Error("superseded"));
    try { if (player) player.stopVideo(); } catch { /* ignore */ }
    state = -1;
    started = false;
    videoId = null;
  }

  return { proxy, start, stop };
}
