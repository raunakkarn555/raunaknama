// Bridges the web player to the native Android media notification /
// lock-screen controls added in the Android project (MediaNotificationPlugin +
// MediaPlaybackService). On desktop/mobile web (no Capacitor wrapper) every
// function here is a no-op, so this is safe to call unconditionally from
// Player.jsx alongside the existing navigator.mediaSession calls.
//
// Inside the wrapped app, Capacitor auto-injects `window.Capacitor` (no npm
// install needed on the web side) and, because MediaNotificationPlugin is
// registered in MainActivity, exposes it at
// `window.Capacitor.Plugins.MediaNotification`.

const getPlugin = () => {
  if (typeof window === "undefined") return null;
  const Capacitor = window.Capacitor;
  if (!Capacitor?.isNativePlatform?.()) return null;
  return Capacitor.Plugins?.MediaNotification || null;
};

export const isNativeShell = () => !!getPlugin();

let initialized = false;
export const nativeMediaSessionInit = () => {
  const plugin = getPlugin();
  if (!plugin || initialized) return;
  initialized = true;
  plugin.initialize().catch(() => {});
};

export const nativeSetMetadata = ({ title, artist, album, artworkUrl }) => {
  const plugin = getPlugin();
  if (!plugin) return;
  plugin.setMetadata({ title, artist, album, artworkUrl }).catch(() => {});
};

export const nativeSetPlaybackState = (playing) => {
  const plugin = getPlugin();
  if (!plugin) return;
  plugin.setPlaybackState({ playing }).catch(() => {});
};

export const nativeSetPositionState = (duration, position, playbackRate = 1) => {
  const plugin = getPlugin();
  if (!plugin) return;
  plugin.setPositionState({ duration, position, playbackRate }).catch(() => {});
};

// Registers listeners for notification/lock-screen button taps relayed up
// from MediaPlaybackService.Callback (see emitToJs in MediaNotificationPlugin.kt).
// Returns a cleanup function that removes all listeners.
export const nativeAddMediaButtonListeners = ({ onPlay, onPause, onNext, onPrevious, onSeek }) => {
  const plugin = getPlugin();
  if (!plugin) return () => {};

  const handles = [
    onPlay && plugin.addListener("play", onPlay),
    onPause && plugin.addListener("pause", onPause),
    onNext && plugin.addListener("next", onNext),
    onPrevious && plugin.addListener("previous", onPrevious),
    onSeek && plugin.addListener("seek", (data) => onSeek(data?.position)),
  ].filter(Boolean);

  // addListener() returns a Promise<PluginListenerHandle>: it must be awaited before
  // remove() exists. (Calling h.remove on the bare Promise silently leaked listeners, so one
  // notification "Next" tap fired many times.)
  return () => {
    handles.forEach((h) => Promise.resolve(h).then((x) => x?.remove?.()).catch(() => {}));
  };
};
