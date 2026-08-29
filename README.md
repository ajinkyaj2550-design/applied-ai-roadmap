# Applied AI Roadmap OS — Gemini Final

This is the 7-file Render/GitHub deployment package for the Applied AI Engineer Roadmap OS.

## Files

- `index.html` — complete UI, roadmap, Interview Mode, Test Mode, notifications and local progress.
- `server.js` — Node backend, opportunity feed, Gemini API proxy, validation, translation and rate limits.
- `opportunities.json` — cached opportunity feed storage.
- `package.json` — Node start configuration.
- `Procfile` — Render start command.
- `render.yaml` — Render service + Gemini environment variable configuration.
- `README.md` — deployment notes.

## Gemini setup on Render

The browser never receives the Gemini API key. The server reads it from an environment variable.

In Render → your Web Service → Environment add:

- `GEMINI_API_KEY` = your Gemini API key
- `GEMINI_INTERVIEW_MODEL` = `gemini-2.5-flash`
- `GEMINI_TEST_MODEL` = `gemini-2.5-flash-lite`
- `GEMINI_TRANSLATE_MODEL` = `gemini-2.5-flash-lite`
- `GEMINI_DAILY_REQUEST_LIMIT` = `180`

Do not put the real key in `index.html`, `server.js`, `README.md`, GitHub, or any client-side JavaScript.

## What uses Gemini

### Interview Mode
- Generates one English technical interview question and answer.
- Uses Google Search grounding for current/tool/API-specific facts.
- Validates the selected level, topic and difficulty.
- Avoids recently used questions where possible.
- Shows supporting sources when Gemini provides them.
- Marathi translation is generated only when the user taps the translation button.
- If Gemini is temporarily unavailable, a built-in English fallback question is used so practice does not stop.

### Test Mode
- Test is placed directly below Interview Mode.
- User chooses level, topic and 10/20/30/50 questions.
- Every question has exactly four English options.
- Selecting an option immediately shows Correct/Incorrect, the correct answer and a reason.
- Every next question is requested dynamically from Gemini when available.
- If Gemini is unavailable, a built-in MCQ fallback is used.
- Marathi translation includes the question, all four options, correct answer and reason.
- Final score and accuracy are shown at the end.

## Notifications / Opportunities

- `/opportunities.json` provides the cached feed.
- Refresh uses `POST /refresh` and has a 45-second server cooldown.
- No `REFRESH_TOKEN` is required.
- Each notification can be dismissed with `✕`.
- Deleted notification IDs are remembered locally so a refresh does not immediately bring them back.
- Read-all and multi-select delete are still available.
- The UI is designed to wrap long URLs/text on mobile screens.
- If the live feed fails, cached local opportunities remain visible.

## Security / quota protection

- Gemini requests are server-side only.
- A per-IP short-window limit and a server-side daily safety limit are included to reduce accidental/public quota abuse.
- The default safety cap is 180 Gemini requests/day. This is deliberately below Google's documented free Search grounding limit so normal use has headroom.
- Translation does not enable Google Search grounding.

## Deploy

1. Replace the files in the GitHub repository with these seven files at the repository root.
2. In Render, make sure the service is connected to that repository and branch.
3. Add `GEMINI_API_KEY` in Render Environment.
4. Save / redeploy.
5. Open `/health` on your Render service. It should report `geminiConfigured: true` and show the selected models.
6. Open the main site and test Interview Mode, then Test Mode.

## Important

The Gemini API key shown in Google AI Studio should be treated as a secret. If it is ever pasted into GitHub, a screenshot, a chat, or another public place, rotate/restrict the key.
