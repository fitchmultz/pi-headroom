# Changelog

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
