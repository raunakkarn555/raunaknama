# Raunaknama

A personal radio site in the spirit of Deluxe Saloon — plays your own playlist
through YouTube's **official** IFrame Player API, with a custom barbershop-radio
interface: hidden video, live "listeners" count, barber-pole progress bar.

**Stack: React (Vite), single app, powered entirely by Firebase.**

> This version has no separate backend server. What used to be a Node/Express
> API talking to MongoDB is now just Firebase, called directly from the
> browser:
> - **Firestore** stores the playlist (replaces MongoDB + the Express CRUD API)
> - **Realtime Database** powers the live "N in the chair" counter (replaces
>   Socket.io)
>
> That means there's only one folder, one `npm install`, one build, and one
> deploy. No backend to host separately.
>
> The `/api/playlists`, `/api/playlist`, `/api/search`, and `/api/stream`
> endpoints (yt-dlp powered) are served by **Netlify Functions** in
> `netlify/functions/`, exposed at `/api/*` via the redirect in
> `netlify.toml` — no standalone server process to deploy or run.

> **Note on ads:** this uses YouTube's real embedded player, just visually
> hidden. That's the only way to do this within YouTube's terms of service.
> Some videos may still show a short ad depending on the uploader's monetization
> settings — there's no legitimate way around that. Picking official
> "Audio"/lyric-video uploads from labels tends to have fewer ads than random
> reuploads.

---

## What changed from the old MongoDB version, at a glance

| Old | New |
|---|---|
| `backend/` (Express + MongoDB + Socket.io) | Deleted entirely |
| `frontend/` folder | Contents moved up to project root |
| MongoDB Atlas | Firebase Firestore |
| Socket.io listener count | Firebase Realtime Database presence |
| Deploy backend (Render/Railway) *and* frontend (Vercel/Netlify) | Deploy **one** static app to Vercel or Netlify |
| Edit playlist via `curl` to your API | Edit playlist via `npm run seed` or the Firebase console |

If you had the old repo cloned, don't try to merge folders — just use this
project as-is; everything you need is here.

---

## 1. What you need

- [Node.js](https://nodejs.org/) 18+
- A free [Firebase](https://firebase.google.com/) account (just a Google
  account — no credit card needed for the free "Spark" plan, which is plenty
  for a personal radio site)

---

## 2. Create your Firebase project

You only need to do this section once.

### Step 1 — Create the project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
   and click **"Add project"**.
2. Give it a name (e.g. `raunaknama`), click through the prompts (you can
   disable Google Analytics — not needed here).

### Step 2 — Enable Firestore (stores the playlist)

1. In the left sidebar: **Build → Firestore Database**.
2. Click **"Create database"**.
3. Choose **"Start in production mode"**, pick any region close to you, click
   **Create**.
4. Go to the **Rules** tab and replace the contents with what's in
   `firestore.rules` in this project (already written for you — public read,
   no public write). Click **Publish**.

### Step 3 — Enable Realtime Database (powers the live listener count)

1. In the left sidebar: **Build → Realtime Database**.
2. Click **"Create database"**, pick a region, choose **"Start in locked
   mode"**.
3. Go to the **Rules** tab and replace the contents with what's in
   `database.rules.json` in this project. Click **Publish**.

### Step 4 — Get your web app config (for `.env`)

1. Click the gear icon → **Project settings**.
2. Scroll to **"Your apps"**, click the **`</>`** (web) icon to register a
   new web app. Name it anything (e.g. "raunaknama-web"). You don't need
   Firebase Hosting here — skip that checkbox.
3. It'll show you a `firebaseConfig` object — you'll copy these values into
   `.env` in step 3 below.
4. Also grab your Realtime Database URL: go back to **Build → Realtime
   Database**, the URL is shown at the top of the data page (looks like
   `https://raunaknama-default-rtdb.<region>.firebasedatabase.app`).

### Step 5 — Get a service account key (only needed to run the seed script)

1. Still in **Project settings**, go to the **Service accounts** tab.
2. Click **"Generate new private key"** → confirm. A JSON file downloads.
3. Rename it to `serviceAccountKey.json` and put it in the **root** of this
   project (next to `package.json`). It's already in `.gitignore` — never
   commit this file or share it; it has full admin access to your project.

---

## 3. Run it locally

```bash
cp .env.example .env
# edit .env: paste in the Firebase config values from step 2.4 above
npm install
```

Now build your playlist. Open `scripts/seed.js` and replace the placeholder
entries with real songs:

```js
{
  youtubeId: "dQw4w9WgXcQ",   // the part after "v=" in the YouTube URL
  title: "Song Title",
  artist: "Artist Name",
  order: 1,
},
```

Where to get `youtubeId`: open the song on YouTube or YouTube Music, copy the
URL, and take everything after `v=` (or after `youtu.be/` on short links).

Then seed Firestore and start the app:

```bash
npm run seed
npm run dev
```

Open `http://localhost:5173` — you should see Raunaknama, hear your playlist,
and see the listener count tick up.

---

## 4. Editing your playlist later

You have two options — no server to restart either way:

**Option A — re-run the seed script.** Edit the track list in
`scripts/seed.js`, then run:

```bash
npm run seed
```

This wipes and replaces the whole `tracks` collection with what's in the
file — good for reordering or bulk changes.

**Option B — edit directly in the Firebase console.** Go to **Build →
Firestore Database → Data**, open the `tracks` collection, and add/edit/delete
documents by hand. Each document needs: `youtubeId` (string), `title`
(string), `artist` (string), `order` (number), and optionally `cover`
(string, a custom image URL). Good for quick one-off tweaks.

Refresh the site and the new track shows up in the queue.

---

## 5. Hosting it online — one deploy, on Vercel or Netlify

Because there's no backend server anymore (Firebase *is* the backend), this
is now a plain static site. **Either Vercel or Netlify works equally well**
— pick whichever you're more comfortable with. Steps below for both.

First, push this project to a GitHub repo (don't forget: `.env` and
`serviceAccountKey.json` should **not** be committed — `.gitignore` already
excludes them).

### Option A — Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import
   your GitHub repo.
2. Framework preset: Vercel auto-detects **Vite** — leave build command as
   `npm run build` and output directory as `dist`.
3. Under **Environment Variables**, add every `VITE_FIREBASE_*` key from your
   `.env` file (same names, same values).
4. Click **Deploy**.

### Option B — Netlify

1. Go to [netlify.com](https://netlify.com) → **Add new site → Import an
   existing project** → connect your GitHub repo.
2. Build command: `npm run build`. Publish directory: `dist`.
3. Under **Site configuration → Environment variables**, add every
   `VITE_FIREBASE_*` key from your `.env` file.
4. Click **Deploy site**.

That's it — one deploy, no separate backend to host, no `CLIENT_ORIGIN` or
CORS config needed (Firebase handles access purely through the security
rules you set up in section 2).

> **Note:** by default Firebase's free Spark plan allows any website to call
> your Firestore/Realtime Database as long as it matches your security
> rules — there's no built-in domain allow-list on the free plan. The rules
> in this project intentionally only allow public *read* on the playlist and
> a narrow *write* on the presence path, so this is safe to leave open.

---

## 6. Customizing the look

- Colors, fonts, and the barber-pole motif live in
  `src/index.css` (tokens) and `src/components/Player.css`.
- Cover art defaults to the YouTube thumbnail for each video. To use your own
  image instead, set a `cover` field on that track (via the seed script or
  Firebase console).
- The "in the chair" listener count is real — it's driven by Realtime
  Database presence (one node per open tab, auto-removed on disconnect), so
  it reflects actual open tabs, not a fake number.

---

## 7. Project structure

```
raunaknama/
├── src/
│   ├── App.jsx              # Layout, listener count, playlist loading
│   ├── firebase.js          # Firebase init (Firestore + Realtime DB)
│   ├── components/
│   │   ├── Player.jsx       # YouTube IFrame API + controls
│   │   └── Player.css       # Barber-pole progress bar, card styling
│   ├── index.css            # Design tokens (colors, fonts)
│   └── main.jsx             # App entry point
├── scripts/
│   └── seed.js               # Populate Firestore with your playlist (admin SDK, local-only)
├── index.html
├── package.json
├── vite.config.js
├── firestore.rules           # Firestore security rules — paste into Firebase console
├── database.rules.json       # Realtime Database security rules — paste into Firebase console
├── .env.example
└── serviceAccountKey.json    # You add this yourself (gitignored) — needed only for `npm run seed`
```

Have fun with it 💈
