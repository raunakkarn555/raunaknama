# YouTube cookies for deployment

Your new cookies were gzip+base64 encoded with `scripts/encode-cookies.mjs`.

- Input cookies.txt: 3016 bytes
- Compressed: 1552 bytes
- Base64 (in `cookies.b64` at repo root): **2072 characters** — well under Netlify's ~5000 char env var cap.

## Set it on Netlify

Do NOT copy the value out of a terminal by hand (see the long comment at the
top of `scripts/encode-cookies.mjs` for why that silently corrupts it).
Instead, from the project root:

```bash
netlify env:set YTDLP_COOKIES_B64 "$(cat cookies.b64)"
```

Or via the dashboard: Site settings -> Environment variables -> add
`YTDLP_COOKIES_B64`, and paste in the exact contents of `cookies.b64` (no
extra newline at start/end).

Then trigger a new deploy (env var changes don't apply to already-running
functions) — either push a commit or use "Trigger deploy" in the Netlify UI.

## Note

`cookies.b64` is included in this zip for convenience, but it encodes your
YouTube session cookies. Don't commit it to a public repo — `.gitignore`
in this project already ignores `*.b64`, so `git add` won't pick it up
by default. Delete it once you've set the env var if you'd rather not
keep it on disk.
