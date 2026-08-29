# Final build notes

## Notification quality
- Dashboard is capped at 30 visible opportunities: dynamic Top 10 + up to 20 genuinely new rotating items.
- Top 10 is recalculated on every refresh; it is not a permanent list.
- New high-value opportunities can displace older Top-10 items.
- Rotating items are marked seen only after they are displayed; Top-10 items are never permanently marked away.
- Expired items are filtered out.
- Duplicate title/source combinations are collapsed.
- Server discovery applies an opportunity-intent gate, trusted-source allowlist, roadmap relevance scoring, deadline urgency, and source diversity.
- Google News RSS redirect links are resolved for the best candidates where possible.
- If fewer than 20 genuinely new items exist, the UI shows fewer than 30 rather than filling with noise.

## Product cleanup
- Interview Mode removed.
- Test Mode removed.
- No Gemini API key is required by the final build.
