import React, { useEffect, useRef, useState } from 'react';
import './GuideButton.css';
import Icon from './Icon';

const FEEDBACK_EMAIL = 'ozopal55@gmail.com';

const DESKTOP_SHORTCUTS = [
  { keys: ['Space'], what: 'Play / Pause' },
  { keys: ['N'], what: 'Next song' },
  { keys: ['P'], what: 'Previous song' },
  { keys: ['→'], what: 'Forward 5 seconds' },
  { keys: ['←'], what: 'Rewind 5 seconds' },
  { keys: ['↑'], what: 'Volume up' },
  { keys: ['↓'], what: 'Volume down' },
  { keys: ['F'], what: 'Full screen on / off' },
  { keys: ['Esc'], what: 'Close search, artist page, full view or any popup' },
];

// Extra keys that only work inside the Full view page.
const FULLVIEW_SHORTCUTS = [
  { keys: ['Space'], what: 'Play / Pause (also here)' },
  { keys: ['←', '→'], what: 'Rewind / forward 5 seconds' },
  { keys: ['Esc'], what: 'Close the Full view' },
];

// What the newer parts of the app can do (shown in the "New" tab).
const NEW_FEATURES = [
  { icon: 'expand', title: 'Full view', text: 'Tap the expand button next to the heart / mic on the player. You get a full page with the big spinning cover, the ring, all controls, a Synced lyrics button and a Close / Back button. On a phone, swipe down from the top to close it.' },
  { icon: 'sparkles', title: 'Mode: Default / Recommended', text: 'Switch from the top bar, from the menu (top of the side drawer) or from the top of the Recommended page. Default is the plain player, Recommended adds endless song shelves.' },
  { icon: 'mic2', title: 'Artists for you', text: 'A row of 12 artists on the Recommended page, new ones every visit. Tap one to open their page and all their songs. Use Shuffle (or the arrows on a laptop) to see more.' },
  { icon: 'listMusic', title: 'Playlists between songs', text: 'A few times while you scroll, a shelf of your playlists (and radio playlists) appears. Tap one to load it into the player.' },
  { icon: 'heart', title: 'Moods', text: 'Pick All, Romantic, Party, Sad, Retro 90s or Workout to get shelves only for that mood.' },
  { icon: 'moon', title: 'Back to top', text: 'On a long Recommended page a gold arrow button appears at the bottom-right. One tap takes you back up to the player.' },
  { icon: 'play', title: 'Fast start', text: 'If a song cannot be streamed fully, the app switches to the YouTube player by itself so it still plays the whole song.' },
];

// Good to know (shown at the bottom of the "New" tab).
const GOOD_TO_KNOW = [
  'The YouTube player mode needs the screen to stay on: on some phones the music can pause when the screen locks. Keep the app open, or use the normal mode.',
  'Artist photos come from the web. If one does not load, you see the initials instead; tapping still works.',
  'Recently played songs are kept on your device for a short while only and clear themselves automatically.',
];

const MOBILE_TIPS = [
  { icon: 'play', title: 'Play any song', text: 'Tap a card or a song in the queue to start it. Use the big centre button to play / pause.' },
  { icon: 'skipNext', title: 'Next / Previous', text: 'Use the skip buttons under the player. Shuffle, autoplay and repeat-one sit right next to them.' },
  { icon: 'search', title: 'Search', text: 'Open search and type any song, movie or artist name. Tap an artist to see all their songs.' },
  { icon: 'heart', title: 'Like a song', text: 'Tap the heart on the player or on any card. Everything you like is saved in the menu under "Liked Songs".' },
  { icon: 'plus', title: 'Add to playlist', text: 'Tap the + / save button on any song to put it in one of your own playlists (saved on this device).' },
  { icon: 'mic', title: 'Lyrics', text: 'Tap the mic button next to the title to read lyrics for the song that is playing.' },
  { icon: 'sparkles', title: 'Synced lyrics', text: 'Open lyrics and tap "Synced view" for a full-screen karaoke view: cover on one side, lyrics moving with the song on the other. Tap any line to jump there.' },
  { icon: 'heart', title: 'Mood chips', text: 'On the Recommended page, pick Romantic, Party, Sad, Retro 90s or Workout to get songs for that mood.' },
  { icon: 'chart', title: 'Your week', text: 'Open the menu to see how long you listened this week, your top artist and most played song (stored only on this device).' },
  { icon: 'moon', title: 'Sleep timer', text: 'Falling asleep to music? Set the sleep timer and playback stops by itself.' },
  { icon: 'dice', title: 'Surprise me', text: 'Not sure what to play? One tap picks a random song for you.' },
  { icon: 'lock', title: 'Lock screen controls', text: 'Play, pause, next and previous also work from your notification shade and lock screen.' },
  { icon: 'expand', title: 'Full screen', text: 'Use the full-screen button in the top bar for an immersive view.' },
  { icon: 'sparkles', title: 'Full view page', text: 'Tap the expand button on the player for a full page with the big cover, ring, buttons and lyrics. Swipe down from the top (or tap Back / X) to close.' },
  { icon: 'radio', title: 'Mode switch', text: 'Open the menu: the Mode switch is at the top. Choose Default or Recommended any time.' },
  { icon: 'mic2', title: 'Artists & playlists', text: 'On the Recommended page, swipe the Artists row sideways and tap a playlist shelf to load it.' },
];

const PLAYLIST_STEPS = [
  { title: 'Menu kholo', text: 'Top bar me menu button dabao. Side drawer khulega jisme "Your playlists" section hota hai.' },
  { title: 'New playlist banao', text: 'Drawer me "+ New playlist" dabao, naam likho aur "Create" dabao. Playlist ban gayi.' },
  { title: 'Gaana add karo', text: 'Kisi bhi gaane ke card par + (save) button dabao, ya player ke paas wala save button. List me se playlist chuno, ya wahin se "New playlist" bana lo.' },
  { title: 'Chalao', text: 'Menu me "Your playlists" me playlist ka naam dabao. Uske saare gaane queue me khul jayenge, kisi par bhi tap karke play karo.' },
  { title: 'Gaana hatao / playlist delete karo', text: 'Playlist khuli ho to gaane ke saamne dustbin icon se gaana hat jata hai. Playlist ke naam ke saamne wale delete button se poori playlist hat jati hai.' },
  { title: 'Playlist share karo', text: 'Menu me playlist ke naam ke saamne share icon dabao. Ek link copy ho jayega (phone par share sheet khulti hai). Dost wo link kholega to "Save to my playlists" ka option aayega aur playlist uski device me save ho jayegi. "Radio playlists" ke naam ke saamne bhi wahi share icon hai: uska link kholte hi seedha wahi radio playlist khul jati hai.' },
  { title: 'Liked Songs', text: 'Heart dabane se gaana "Liked Songs" me chala jata hai (menu me milega). Dobara heart dabao to hat jata hai.' },
];

function GuideButton() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('laptop');
  const bodyRef = useRef(null);
  const [progress, setProgress] = useState(0);
  const onBodyScroll = (e) => {
    const el = e.currentTarget;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max > 0 ? Math.min(1, el.scrollTop / max) : 0);
  };
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    setProgress(0);
  }, [tab, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="guide-fab"
        aria-label="Open guide and keyboard shortcuts"
        title="Guide & shortcuts"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">i</span>
      </button>

      {open && (
        <div className="guide-overlay" onMouseDown={() => setOpen(false)}>
          <div
            className="guide-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="guide-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="guide-head">
              <div>
                <span className="guide-eyebrow">Raunaknama</span>
                <h2 id="guide-title" className="guide-title">How to use</h2>
              </div>
              <button type="button" className="guide-close" aria-label="Close guide" onClick={() => setOpen(false)}>
                &times;
              </button>
            </div>

            <div className="guide-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'laptop'}
                className={`guide-tab ${tab === 'laptop' ? 'is-active' : ''}`}
                onClick={() => setTab('laptop')}
              >
                <Icon name="laptop" /> Laptop
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'playlists'}
                className={`guide-tab ${tab === 'playlists' ? 'is-active' : ''}`}
                onClick={() => setTab('playlists')}
              >
                <Icon name="listMusic" /> Playlists
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'new'}
                className={`guide-tab ${tab === 'new' ? 'is-active' : ''}`}
                onClick={() => setTab('new')}
              >
                <Icon name="sparkles" /> New
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'mobile'}
                className={`guide-tab ${tab === 'mobile' ? 'is-active' : ''}`}
                onClick={() => setTab('mobile')}
              >
                <Icon name="phone" /> Mobile
              </button>
            </div>

            <div className="guide-progress" aria-hidden="true"><span style={{ transform: `scaleX(${progress})` }} /></div>
            <div className="guide-body" ref={bodyRef} onScroll={onBodyScroll}>
              {tab === 'laptop' ? (
                <>
                  <p className="guide-intro">
                    Keyboard shortcuts work anywhere on the page (except while you are typing in a text box).
                  </p>
                  <ul className="guide-list">
                    {DESKTOP_SHORTCUTS.map((s) => (
                      <li key={s.what} className="guide-row">
                        <span className="guide-keys">
                          {s.keys.map((k) => (
                            <kbd key={k} className="guide-kbd">{k}</kbd>
                          ))}
                        </span>
                        <span className="guide-what">{s.what}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="guide-subhead">In the Full view</p>
                  <ul className="guide-list">
                    {FULLVIEW_SHORTCUTS.map((s) => (
                      <li key={s.what} className="guide-row">
                        <span className="guide-keys">
                          {s.keys.map((k) => (
                            <kbd key={k} className="guide-kbd">{k}</kbd>
                          ))}
                        </span>
                        <span className="guide-what">{s.what}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="guide-intro guide-intro--small">
                    Tip: in lyrics, "Synced view" opens full-screen karaoke lyrics (Esc to close). Menu shows "Your week" stats.<br />Tip: hover over any song card to see the heart (like) and + (add to playlist) buttons.
                  </p>
                </>
              ) : tab === 'playlists' ? (
                <>
                  <ol className="guide-list guide-steps">
                    {PLAYLIST_STEPS.map((st, i) => (
                      <li key={st.title} className="guide-tip">
                        <span className="guide-tip-icon guide-step-num" aria-hidden="true">{i + 1}</span>
                        <span className="guide-tip-text">
                          <strong>{st.title}</strong>
                          <span>{st.text}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                  <div className="guide-note">
                    <strong>Playlists kahan save hoti hain?</strong>
                    <span>
                      Teri playlists aur liked songs sirf isi device ke isi browser me (localStorage) save hoti hain.
                      Server par kuch upload nahi hota, isliye login ki zaroorat nahi. Lekin browser ka cache / site data
                      clear karne par ya doosre phone / laptop par ye nahi dikhengi.
                    </span>
                    <span>
                      <b>Backup:</b> menu ke "Your playlists" section me "Download backup" se file save kar lo, aur kisi
                      bhi device par "Upload backup" se wapas la sakte ho. Naya phone ya laptop lene se pehle backup zaroor lo.
                    </span>
                  </div>
                </>
              ) : tab === 'new' ? (
                <>
                  <ul className="guide-list guide-list--tips">
                    {NEW_FEATURES.map((t) => (
                      <li key={t.title} className="guide-tip">
                        <span className="guide-tip-icon" aria-hidden="true"><Icon name={t.icon} size="16px" /></span>
                        <span className="guide-tip-text">
                          <strong>{t.title}</strong>
                          <span>{t.text}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="guide-note">
                    <strong>Good to know</strong>
                    {GOOD_TO_KNOW.map((g) => <span key={g}>{g}</span>)}
                  </div>
                </>
              ) : (
                <ul className="guide-list guide-list--tips">
                  {MOBILE_TIPS.map((t) => (
                    <li key={t.title} className="guide-tip">
                      <span className="guide-tip-icon" aria-hidden="true"><Icon name={t.icon} size="16px" /></span>
                      <span className="guide-tip-text">
                        <strong>{t.title}</strong>
                        <span>{t.text}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="guide-foot">
              <button type="button" className="guide-close-btn" onClick={() => setOpen(false)}>
                Close
              </button>
              <span>Suggestions or problems? Write to us:</span>
              <a
                className="guide-mail"
                href={`mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent('Raunaknama – suggestion')}`}
              >
                {FEEDBACK_EMAIL}
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default GuideButton;
