# Applied AI Roadmap OS — Final

## Final notification design
- Dashboard shows a maximum of 30 opportunities.
- Top 10 are **dynamic**, not permanent. They are recalculated from all active opportunities on every refresh.
- If a new opportunity is more important, it can enter the Top 10 and push an older item out.
- Up to 20 additional slots are filled only with opportunities that have not previously been shown as rotating/new items.
- If fewer genuinely new opportunities exist, fewer than 30 are shown. The app never fills the list with irrelevant/cid-bid items.
- Expired opportunities are removed.
- Duplicate opportunities are deduplicated by title + source domain.
- Ranking considers roadmap relevance, opportunity type, trusted source, deadline urgency, India/remote/global relevance and other useful signals.
- Notifications include the resolved source/application link from the feed; the system does not invent links.
- localStorage keeps the notification history, read state and seen-rotation IDs across refreshes.
- Deleting an item removes it from the current local display; a highly ranked item can return later if it belongs in the dynamic Top 10.
- Manual refresh has a 45-second server cooldown. Automatic background sync runs every 6 hours.
- The backend keeps a larger cache, but the UI never dumps the whole cache to the user.

## API key
No Gemini API key is required by the final build. Interview Mode and Test Mode are removed from the final product, along with their Gemini dependency.
Opportunity discovery uses public RSS feeds and deterministic server-side filtering/ranking.

## Roadmap
The 9-level Applied AI Engineer curriculum remains in the app. The Master Roadmap button opens the full roadmap summary.
