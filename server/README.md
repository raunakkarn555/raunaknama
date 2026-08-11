# Music server — YouTube access setup (required on Render)

There are **two separate YouTube blocks** you'll hit on Render, and you need to fix both. Check your
logs to see which one you're looking at.

## Block type 1 — "Sign in to confirm you're not a bot"

If your logs show that exact phrase, see "Step 1/2 — cookies" below. This is YouTube's login-wall.

## Block type 2 — "Requested format is not available" (with no bot-check message)

If yt-dlp downloads the webpage fine but then every format selector fails identically — e.g.:

```
Streaming audio for track ID: xxxx
Format "bestaudio[ext=m4a]/..." unavailable, trying fallback.
ERROR: Requested format is not available. Use --list-formats for a list of available formats
```

this is **not** the bot-check — it's YouTube's newer **SABR** enforcement, which quietly hands back
zero downloadable adaptive audio/video formats to requests from datacenter IP ranges (Render, AWS,
GCP, etc.), independent of cookies or which player client you use. Cookies alone will **not** fix
this. See "Step 3 — proxy" below, which is the fix that currently works.

If your logs show cookies configured and you're still hitting this, skip straight to Step 3.

## Step 1 — Export your YouTube cookies

1. Open **youtube.com** in Chrome (or Firefox) and make sure you're **logged in**.
2. Install a cookie-export extension, e.g. **"Get cookies.txt LOCALLY"** (Chrome Web Store).
3. While on youtube.com, click the extension and export cookies in **Netscape format** — save the file
   as `cookies.txt`.

Use a normal/secondary Google account if you'd rather not use your main one — any logged-in YouTube
session works.

## Step 2 — Give the cookies to the server

Pick **one** of these (both are already supported by `server.js`):

### Option A — Render "Secret File" (simplest)
1. In the Render dashboard, open your service → **Environment** → **Secret Files**.
2. Add a file with path `/etc/secrets/cookies.txt` and paste the contents of `cookies.txt`.
3. Add an environment variable:
   ```
   YTDLP_COOKIES_PATH=/etc/secrets/cookies.txt
   ```

### Option B — Environment variable (base64)
1. Base64-encode the file so it's safe to paste as a single-line env var:
   ```bash
   base64 -w0 cookies.txt   # macOS: base64 -i cookies.txt
   ```
2. In Render → **Environment**, add:
   ```
   YTDLP_COOKIES_B64=<paste the base64 string here>
   ```

The server reads whichever one you set on startup (Secret File takes priority) and passes it to every
yt-dlp call automatically. Redeploy after adding either variable.

## Step 3 — Residential proxy (the real fix for "Requested format is not available")

1. Sign up for any cheap residential/mobile proxy provider (e.g. Webshare, IPRoyal, Smartproxy). You
   don't need much bandwidth — audio streaming from a music app is light traffic. A few GB/month is
   plenty for personal use.
2. Get your proxy's connection URL, in the form:
   ```
   http://username:password@proxy-host:port
   ```
3. In Render → **Environment**, add:
   ```
   YTDLP_PROXY=http://username:password@proxy-host:port
   ```
4. Redeploy. `server.js` now passes `--proxy` to every yt-dlp call automatically (see `authArgs()`).

Why this is required: Render's outbound IPs are well-known datacenter ranges. YouTube's SABR system
increasingly refuses to hand out playable adaptive formats to those ranges regardless of cookies or
which client (`android`/`ios`/`web`) yt-dlp pretends to be. Routing the request through a residential
IP is currently the only lever that reliably restores normal format availability. Keep cookies
configured too (Step 1/2) — you want both: cookies solve the login-wall, the proxy solves the
IP-reputation/SABR wall.

## Step 4 (optional, best-effort) — PO Token provider

You can additionally run a [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
sidecar and point `server.js` at it with `YTDLP_POT_PROVIDER_URL=http://localhost:4416`. This can help
on the margins, but as of 2026 the project's own maintainers note that PO tokens alone no longer
bypass YouTube's bot-check for most flagged datacenter IPs — treat Step 3 (the proxy) as the fix, and
this as a minor supplement, not a substitute.

## Notes

- Cookies **do expire** (typically weeks to a couple months). If streaming/search suddenly starts
  failing again with the same "Sign in to confirm" message, just re-export `cookies.txt` and update the
  env var/secret file — no code changes needed.
- Without cookies configured, the server still tries YouTube's Android client as a free fallback
  (`player_client=android`), which sometimes avoids the check for a while — but YouTube tightens this
  periodically, so don't rely on it long-term.
- Never commit `cookies.txt` to git — it's tied to your account. Keep it only in Render's secret
  storage / env vars.

## Why the site felt slow, and what changed

- `/api/playlist` and `/api/search` responses are now cached in-memory for 20 minutes, so repeat loads
  and tab switches are instant instead of re-running yt-dlp every time.
- The default playlist is pre-fetched once at server startup, so the very first visitor after a cold
  start isn't stuck waiting on it either.
- `/api/stream` no longer transcodes audio through ffmpeg — it pipes YouTube's native m4a/AAC stream
  straight through, so playback starts almost immediately instead of waiting on a CPU-heavy re-encode.
