# Applied AI Roadmap OS

This project contains the complete 7-file deployment package:

- `index.html` — roadmap UI, notifications, Interview Mode and Test Mode
- `server.js` — same-origin backend, opportunity refresh, dynamic interview/test APIs and translation
- `opportunities.json` — server-side opportunity cache; it is refreshed by `/refresh`
- `package.json` — Node start configuration
- `Procfile` — Render/Node process command
- `render.yaml` — Render service configuration
- `README.md` — setup notes

## Deploy

1. Push all seven files to the repository root.
2. Deploy the service on Render using the included `render.yaml`, or use `node server.js` as the start command.
3. Add `OPENAI_API_KEY` as a Render Environment Variable. Never put the real key in `index.html`, `README.md`, or GitHub.
4. Optional: set `OPENAI_INTERVIEW_MODEL` if you want to override the default model.

## Local

```bash
npm start
```

Then open the server URL in a browser.

## Main endpoints

- `GET /health`
- `GET /opportunities.json`
- `POST /refresh`
- `POST /interview-question`
- `POST /interview-translate`
- `POST /test-question`

The frontend uses the same-origin endpoints automatically, so no API key is exposed to the browser.
