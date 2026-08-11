# Music server — YouTube cookies setup (required on Render)

If your logs show:

```
Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.
```

this is **YouTube itself** blocking Render's IP, not a bug in this server. YouTube trusts almost no
cloud/datacenter IP (Render, AWS, GCP, etc.) without proof of a real, signed-in browser session. Every
Render deployment of a yt-dlp server needs this fixed once — it's a 5 minute setup and then it just works.

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
