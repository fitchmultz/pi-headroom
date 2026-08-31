# pi-headroom

Model-managed context windows for [pi](https://github.com/earendil-works/pi-mono): the model sees how much context it has left and decides when to start a fresh window — with hard cutovers instead of lossy compaction summaries.

![pi-headroom flow](diagram.png)

Same idea as Codex's token-budget flow ([openai/codex#27488](https://github.com/openai/codex/pull/27488), [openai/codex#39827](https://github.com/openai/codex/pull/39827)), but local-only and non-destructive.

## How it works

1. **Meter** — a `[headroom]` message injected before every LLM call shows live usage: `Context 28,478/400,000 tokens (7% used).`
2. **`new_context` tool** — the model calls it when the window is nearly full or no longer useful. Earlier conversation leaves context immediately. No summary is generated.
3. **`notes` tool** — persistent notes in `.pi/notes/` that survive resets (`list` / `read` / `write` / `append` / `search`). The model is instructed to save state *before* cutting over.
4. **`history` tool** — searches/reads the session transcript on disk (`search` / `read`), so dropped conversation is recoverable on demand.

The cut is implemented through pi's `context` hook, so it's non-destructive: the session JSONL keeps the full transcript. Auto-compaction stays enabled as the fallback if the model never resets — and the guidance anchors "nearly full" to your real compaction settings (e.g. `reserveTokens: 64000` on a 400k window → "auto-compaction fires at ~84%"); if compaction is disabled, the model is told it must manage the window itself.

## Load

```bash
pi install git:github.com/fitchmultz/pi-headroom
```

Or load the file directly: `pi -e /path/to/pi-headroom/index.ts`.

## Develop

```bash
npm install
npm run check   # tsc --noEmit
```

## Prompt caching

Cache-safe by construction: the meter is a context-only tail message (never persisted), and the guidance append is a constant string inside the cached system-prompt prefix. Measured on a 3-turn probe: 28k-token prefix written once, `cacheRead=28041` on every later request. A `new_context` cut invalidates the prefix once, by design, and the fresh window is small and re-caches immediately.

## Known ceilings

- **Cut is a session custom entry** (`headroom-cut` / `firstKeptEntryId`). Resume and new processes honor it. The transcript on disk is still complete; only the LLM request is sliced.
- **First-request meter reads low.** `getContextUsage()` is usage-backed, so the very first request of a session (before any response) shows a near-zero estimate. It self-corrects after the first response.
- **Notes live in the project** (`.pi/notes/`). Add it to `.gitignore` if you don't want notes committed.
- History search is substring grep over JSONL, not semantic search. It's enough.
