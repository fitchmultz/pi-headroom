# Changelog

## 0.3.0

- Rebuilds automatic handoffs as bounded recovery records that retain direct user inputs, `ask_question` outcomes, visible coordination, and a clearly stale older checkpoint without inferring state from assistant prose.
- Lets Pi's enabled automatic compaction lifecycle own threshold, overflow, and restart rollovers; disabling compaction now disables automatic headroom behavior while leaving `new_context` available.
- Makes the checkpoint reminder imperative and best-effort, aligns its cutoff with Pi's first actual trigger token, and filters wrong-window reminders from model input.
- Searches nested session files and returns newest history matches first while keeping reads streaming and bounded.

## 0.2.2

- Keeps active work running across automatic rollovers without starting another response after completed work.
- Carries the current window's user requests and constraints into automatic handoffs.

## 0.2.1

- Streams archived history and stops at the requested entry or result limit, preventing heap exhaustion in large session directories and parallel reads.

## 0.2.0

- Replaces extension-only context slicing with Pi's native, persisted `context_window` boundary.
- Makes `new_context` atomic after the full tool batch and adds an optional persisted handoff.
- Replaces the per-request meter with stable guidance, one checkpoint reminder, and `get_context_remaining`.
- Converts automatic summary compaction into a no-summary rollover.
- Makes history search normalized and window-aware, with paginated reads for complete recovery.

## 0.1.3

- Follows the pi package contract: `typebox` and `@earendil-works/pi-coding-agent` are optional peer dependencies (pi provides them at runtime); the pinned copies moved to `devDependencies` for local validation only.
- Adds MIT license and package-gallery metadata.

## 0.1.2

- Declares `pi.extensions` in `package.json` so `pi install` actually discovers and loads the extension.

## 0.1.1

- `new_context` cuts persist across process restarts via a `headroom-cut` session entry (`firstKeptEntryId`); resume slices from the same point instead of reloading the full transcript.
- Guidance reads the user's real compaction settings and states the actual auto-compaction threshold; warns when compaction is disabled.

## 0.1.0

Initial release: live `[headroom]` context meter, `new_context` hard cutover tool, persistent notes in `.pi/notes/`, transcript history search.
