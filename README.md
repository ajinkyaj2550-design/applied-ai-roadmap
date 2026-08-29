# Applied AI Roadmap — server

Flat, single-folder deploy. `server.js` serves `index.html`,
`/opportunities.json`, `/interview-questions.json`, and handles the
`/refresh` (POST) and `/health` endpoints. No API key required anywhere.

## Deploy (Render)
Upload/replace ALL files in this folder as your repo root, keep
`render.yaml` / `Procfile` / `package.json` as-is, redeploy.

## What changed in this version
1. `/refresh` no longer requires a token when REFRESH_TOKEN isn't set on
   the server (it wasn't set in render.yaml before) — pressing the
   Refresh button now works immediately, no API key needed. A 45s
   server-side cooldown prevents accidental spam-refreshing.
2. Each opportunity/notification card has a ✕ button to dismiss it
   individually (removes it from local storage, doesn't just mark read).
3. Interview Mode question/answer pairing bug fixed — questions and
   answers were previously mismatched by array index. Now sourced from
   correctly-paired local data plus a new `/interview-questions.json`
   "online" bank (50 questions) served by this same backend, no key.
