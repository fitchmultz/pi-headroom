# Changelog

## 0.4.0

Renamed to Posthorse (`pi-posthorse`). Requires the `fitchmultz/pi` fork at the revision pinned in the README.

- Claims Pi's automatic threshold and overflow trigger through the fork's new `session_before_auto_compact` hook, before summarization credentials or a summary region are required. A single oversized first turn, an oversized tool result, and a missing summarization login now all roll over.
- Carries the trailing tool batch that no model has consumed yet in the automatic handoff: call arguments, bounded result text, and the entry ids needed to recover the rest. Consumed batches and older assistant prose are still left out. Newly submitted input survives preflight rollover separately instead of being copied into the handoff.
- Returns stored images from `history read`, summarizes images as `[N images: type]` in search results and handoffs, and never embeds base64 in handoff text.
- Reports context as a best available native estimate; `get_context_remaining` shows tokens until Pi's rollover line and until the hard limit, or only the hard limit when compaction is disabled.
- Detects unsupported small-context configurations (fewer than 10,000 usable tokens) with an actionable message instead of rolling over every turn; explicit and automatic handoffs plus unknown-usage read pages leave half the fresh capacity after prompt/tool overhead and pending input free, while known-usage pages budget returned images, shrink to the remaining space, and preserve the offset when refused.
- Reads Pi's effective compaction settings through `ctx.getCompactionSettings()`, so untrusted project settings are ignored exactly as Pi ignores them.
- Fingerprints reminders by window, context size, and reserve; switching to a different context size gets a fresh reminder and stale ones are filtered. Legacy `headroom-reminder` entries remain recognized. The reminder band uses usable context rather than the full model window, avoiding immediate checkpoint loops with a large reserve.
- Notes resolve the repository root from nested directories and linked worktrees (absolute or relative `gitdir`), page long reads with `offset`, allow an empty write to clear a note, append one atomic newline-terminated record per call, and center search excerpts on the match.
- History flattens `bashExecution` entries (placeholder only when Pi marked them `excludeFromContext`), reports fork-copied entries once, and documents all-session ordering as newest-modified sessions first.
- Adds CI (Node 22.19 and 24), `prepublishOnly`, and `scripts/integration.sh`, which loads the real extension into the fork's test harness without API keys.

## 0.3.1

- Resolves `notes` to the main checkout when Pi runs inside a linked git worktree, so every worktree of a repository shares one notebook and notes outlive the worktree.

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
