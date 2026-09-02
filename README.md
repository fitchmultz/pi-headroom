# pi-headroom

Native, model-managed context windows for a personal patched [Pi](https://github.com/earendil-works/pi): hard cutovers without lossy compaction summaries.

![pi-headroom flow](diagram.png)

The model gets stable window guidance, a best-effort near-limit checkpoint, and an on-demand budget tool. A rollover removes the old window from active model context while preserving the complete session transcript.

## Requirement

This version requires the native context-window patch on the personal [`fitchmultz/pi`](https://github.com/fitchmultz/pi) fork. The official Pi package does not yet provide the boundary used here.

Build the patched checkout, then launch its CLI directly with the extension:

```bash
cd /Users/mitchfultz/Projects/pi
npm run build
node packages/coding-agent/dist/bundle/cli.js \
  -e /Users/mitchfultz/Projects/pi-stuff/pi-headroom/index.ts
```

A `pi` launcher linked to that patched bundle works too.

## How it works

1. **Stable guidance** — window behavior is part of the system prompt. There is no changing per-request meter to churn the prompt.
2. **Best-effort checkpoint** — while Pi compaction is enabled, one reminder may appear shortly before the configured reserve line. A large turn, overflow, restart, or smaller model can reach rollover without it.
3. **`get_context_remaining`** — returns an exact native usage reading only when the model needs it.
4. **`new_context`** — requests an atomic rollover after the complete tool batch. An optional handoff is persisted and becomes the first state in the fresh window.
5. **Automatic recovery** — Pi's enabled automatic summary-compaction path becomes the same no-summary rollover. Its bounded recovery record keeps direct user inputs, `ask_question` outcomes, and visible coordination from the current window. Older handoffs are labeled possibly stale; assistant prose is not treated as state.
6. **Late-reminder filter** — an old-window reminder is removed from model input if queue ordering lets it arrive after a boundary. The persisted transcript remains untouched.
7. **`notes` and `history`** — durable project notes and normalized, window-aware transcript recovery remain available after rollover. All-session history searches nested session files from newest to oldest.

Automatic recovery is an emergency input record, not proof of current progress. The fresh model is told to restore notes and todo state, inspect history when needed, and verify live state before taking stateful or external action.

Pi persists a real `context_window` session entry. Session replay, usage accounting, branch navigation, compaction, and provider input use the same authoritative boundary; the JSONL transcript remains append-only and complete.

## Settings

Headroom follows Pi's `compaction.enabled` setting. Disabling automatic compaction also disables checkpoint reminders and automatic headroom rollover; explicit `new_context` remains available. Manual `/compact` is unchanged.

## Tools

- `new_context({ handoff? })`
- `get_context_remaining()`
- `notes({ op, ... })`: `list`, `read`, `write`, `append`, `search`
- `history({ op, ... })`: `search`, `read`; results include native window IDs, and long reads return the next character offset

Notes live in `.pi/notes/`. Add that directory to `.gitignore` when the project should not track them.

## Develop

```bash
npm ci
npm test
npm run check
```

For end-to-end testing, use the patched Pi bundle or a `pi` launcher that resolves to it.
