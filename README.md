<div align="center">

# Raunaknama

**Where every feeling finds its sound.**

A private, premium Bollywood & Hindi music player for the web, Windows and Android. Search any song, sync the lyrics, build playlists, and share them with a link.

![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white&style=flat-square)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white&style=flat-square)
![Firebase](https://img.shields.io/badge/Firebase-10-FFCA28?logo=firebase&logoColor=black&style=flat-square)
![Netlify](https://img.shields.io/badge/Netlify-Functions-00C7B7?logo=netlify&logoColor=white&style=flat-square)
![Platforms](https://img.shields.io/badge/Web%20%7C%20Windows%20%7C%20Android-e2ab3f?style=flat-square)

[**Download the app**](https://github.com/raunakkarn555/raunaknama-music/releases/tag/v4) &nbsp;·&nbsp; [Features](#features) &nbsp;·&nbsp; [Install](#install-the-app) &nbsp;·&nbsp; [Run locally](#run-it-locally) &nbsp;·&nbsp; [Deploy](#deploy)

</div>

---

## About

Raunaknama is a personal radio and music player with a warm gold and maroon look. It is built for people who just want to open a page, search a song, and listen: no ads in the interface, no clutter, no account to create.

The whole site sits behind a password, so it stays your own private listening room. The Windows and Android apps are available from the [Releases page](https://github.com/raunakkarn555/raunaknama-music/releases/tag/v4).

## Features

### Listening
- **Search any song.** Type a song, an artist, or a few words from the lyrics. Voice search is built in (Chrome, Edge and Safari).
- **Recommended page** with mood chips: Romantic, Party, Sad, Retro 90s and Workout. Each mood has a wide mix of artists, so the shelves never feel repetitive.
- **Radio playlists** loaded from Firebase, plus an endless "Now Playing" queue.
- **Artist pages** with an About section and all of an artist's songs.
- **Surprise me.** One tap plays a random track.
- **Autoplay, shuffle, repeat-one**, and a **sleep timer** for falling asleep to music.
- **Lock-screen and notification controls** on phones (Media Session), and native media notification support in the Android app.

### Lyrics
- **Plain lyrics** for the song that is playing.
- **Synced lyrics (karaoke view).** A full-screen view with the cover on one side and the lyrics moving along with the song. Tap any line to jump to it.
- Lyrics are looked up from several sources (LRCLIB, NetEase, JioSaavn and lyrics.ovh), so most songs get lyrics.

### Your library
- **Liked songs.** The heart has an Instagram-style burst animation.
- **Your playlists.** Create playlists and add songs from any card. They are saved on your device.
- **Share playlists with a link.** Your own playlists are packed into the link itself, and a friend gets a "Save to my playlists" prompt. Radio playlists share a short `?radio=<id>` link.
- **Backup and restore.** Download all your playlists and liked songs as a file and upload it on any device.
- **Your week.** See how long you listened, your top artist and your most played song. This is stored only on your device.

### Look and feel
- Full-bleed photo backdrop that **crossfades** on every track change, with the title sliding in.
- Premium login screen, glass cards and a single consistent line-icon set (no emojis).
- Keyboard shortcuts on desktop, and a built-in **How to use** guide.
- Responsive: separate backdrop photos for phones, and a layout built for touch.

### Keyboard shortcuts (desktop)

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `N` / `P` | Next / previous song |
| `←` / `→` | Rewind / forward 5 seconds |
| `↑` / `↓` | Volume up / down |
| `F` | Full screen on / off |
| `Esc` | Close search, artist page or any popup |

## Install the app

All builds are on the [**Releases page (v4)**](https://github.com/raunakkarn555/raunaknama-music/releases/tag/v4). Open it and scroll down to **Assets**.

### Windows
1. Download a `.exe` from **Assets**. The **Setup** file installs the app. The **Portable** file runs without installing.
2. Double-click the file.
3. If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**. The app is not code-signed, so this warning is normal.
4. In the installer, click **Next** until it finishes. The app appears on your Desktop and in the Start menu.

### Android
1. On your phone, open the Releases page and tap the `.apk` file under **Assets**.
2. When the download finishes, open the file from the notification or from **Files → Downloads**.
3. If Android asks, allow **Install unknown apps** for your browser in Settings.
4. Tap **Install**, then **Open**.

## Tech stack

| Layer | What is used |
|---|---|
| Frontend | React 18, Vite 5, plain CSS (no UI library) |
| Data | Firebase Firestore (playlists), Firebase Realtime Database (live listener count) |
| API | Netlify Functions at `/api/*` |
| Streaming | `yt-dlp`, `youtubei.js` and `bgutils-js`, with a Range-aware audio proxy |
| Playback | HTML5 audio with `hls.js` for HLS streams |
| Lyrics | LRCLIB, NetEase, JioSaavn, lyrics.ovh |
| Android app | Capacitor wrapper with native media notification |

## Project structure

```
.
├── src/
│   ├── App.jsx                  # shell, backdrop crossfade, footer taglines
│   ├── components/
│   │   ├── Player.jsx           # player, queue, search, playlists, drawer
│   │   ├── Dashboard.jsx        # Recommended page and mood chips
│   │   ├── SyncedLyrics.jsx     # full-screen karaoke lyrics
│   │   ├── ArtistPage.jsx
│   │   ├── MediaGrid.jsx
│   │   ├── PasswordGate.jsx     # login screen
│   │   ├── GuideButton.jsx      # "How to use" guide
│   │   ├── AppDownloads.jsx     # "Get the app" card
│   │   └── Icon.jsx             # shared line-icon set
│   ├── lib/                     # audio engine, native media session, heart burst
│   └── hooks/
├── netlify/functions/           # search, stream, audio-proxy, lyrics, playlists, auth...
├── scripts/                     # seed.js, yt-dlp downloader, cookie encoder
├── public/                      # backdrop photos, icons, manifest
├── firestore.rules
├── database.rules.json
└── netlify.toml
```

## Run it locally

**You need:** Node.js 18.18 or newer, and a free [Firebase](https://firebase.google.com/) project.

```bash
git clone https://github.com/raunakkarn555/raunaknama-music.git
cd raunaknama-music
cp .env.example .env      # then fill in your values (see below)
npm install               # also downloads the yt-dlp binary
npm run seed              # optional: load your starting playlist into Firestore
npm run dev               # starts Vite + Netlify Functions together
```

Open **http://localhost:8888**. Do not use port 5173, because the `/api/*` functions only run behind 8888.

### Environment variables

| Variable | Purpose |
|---|---|
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID` | Firebase web app config |
| `VITE_FIREBASE_DATABASE_URL` | Realtime Database URL |
| `VITE_API_BASE_URL` | Leave blank when the API is served from the same site |
| `SITE_PASSWORD` | The password visitors must enter (server only) |
| `SITE_AUTH_SECRET` | Random secret that signs the 7-day session cookie. Generate with `openssl rand -hex 32` |
| `YTDLP_COOKIES_B64` | Base64 YouTube cookies, needed for playback (see below) |
| `AUDIO_PROXY_SECRET` | Signs audio-proxy URLs (falls back to `SITE_AUTH_SECRET`) |
| `PIPED_API_INSTANCES` | Optional comma-separated Piped instances as a backup resolver |

All server variables stay on the server and are never included in the browser bundle.

### Firebase setup (one time)
1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. Enable **Firestore** and publish the rules from `firestore.rules`.
3. Enable **Realtime Database** and publish the rules from `database.rules.json`.
4. Register a web app and copy its config into `.env`.
5. To use `npm run seed`, generate a service account key, save it as `serviceAccountKey.json` in the project root, and keep it private.

### YouTube cookies (needed for playback)
YouTube blocks stream extraction from anonymous server sessions, so playback needs cookies from a signed-in account (a throwaway account is safer).

1. Export `youtube.com` cookies in Netscape format with a cookie-export extension.
2. Encode them with `node scripts/encode-cookies.mjs`.
3. Put the result in `YTDLP_COOKIES_B64`, locally in `.env` or in Netlify's environment variables.

Cookies expire after a few weeks to months. If songs suddenly stop playing, export and set them again. More detail is in [`COOKIES_SETUP.md`](COOKIES_SETUP.md).

## Deploy

The project is set up for **Netlify**, which serves the static site and the functions together.

1. Push the repo to GitHub.
2. In Netlify choose **Add new site → Import an existing project** and pick the repo.
3. Build command `npm run build`, publish directory `dist` (already set in `netlify.toml`).
4. Add every variable from the table above under **Site settings → Environment variables**.
5. Deploy. The `/api/*` redirect to the functions is already configured.

## Security notes

- **Never commit** `.env`, `serviceAccountKey.json`, `cookies.txt` or `cookies.b64`. They contain secrets and session cookies, and `.gitignore` already excludes `.env`, `serviceAccountKey.json` and `*.b64`. Check that `cookies.b64` is not tracked before pushing.
- The password is checked on the server. It never appears in the frontend code.
- Playlists and liked songs live in your browser's `localStorage`, so clearing site data removes them. Use **Download backup** first.

## Disclaimer

Raunaknama is a personal, non-commercial project made for learning and private listening. It does not host any audio. Songs are streamed from third-party sources, and all music, artwork and lyrics belong to their respective owners. Please respect the terms of service of those platforms and the rights of artists. If you are a rights holder and want something removed, open an issue.

## Credits

Crafted with care by **Raunak**.

Thanks to the open-source projects this builds on: React, Vite, Firebase, `yt-dlp`, `youtubei.js`, `hls.js` and LRCLIB.
