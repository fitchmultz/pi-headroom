# Posthorse

**Fresh context. Same journey.** (POST-horse)

Native, no-summary context windows for the [`fitchmultz/pi`](https://github.com/fitchmultz/pi) fork of [Pi](https://github.com/earendil-works/pi). A post-horse was swapped in at relay stations so the courier and the message could continue on fresh legs. Posthorse does the same for a model: fresh context, same work, complete recoverable transcript.

![Posthorse flow](https://raw.githubusercontent.com/fitchmultz/pi-posthorse/main/diagram.png)

Pi owns the persisted boundary. Posthorse owns the policy: stable window guidance, one best-effort checkpoint reminder, `new_context`, `get_context_remaining`, durable `notes`, and window-aware `history`. A rollover removes the old window from active model context while the JSONL transcript stays append-only and complete.

## Requirements

- Node `>=22.19.0`.
- The `fitchmultz/pi` fork. The CI baseline is `f9b06177e565f70cd243a785d088d1c491830dbd` (Pi `0.85.0`). Posthorse needs the fork's native `context_window` entries, its `session_before_auto_compact` hook, and `ctx.getCompactionSettings()`.
- Official, unpatched Pi is unsupported. Posthorse reports a clear extension error at session start and cannot operate; Pi itself keeps running.

## Install

Build the fork:

```bash
git clone https://github.com/fitchmultz/pi.git
cd pi
git checkout f9b06177e565f70cd243a785d088d1c491830dbd
npm install --ignore-scripts
npm run build
```

After updating the fork, run the install and build commands again, then restart Pi. `pi --version` reads the checkout's package metadata, so it does not prove that the updated source has been built.

Run it as `node packages/coding-agent/dist/bundle/cli.js`, or run `npm link` inside `packages/coding-agent` so that build becomes your `pi` command.

Then install Posthorse with that `pi`:

```bash
pi install git:github.com/fitchmultz/pi-posthorse        # from Git; add @<tag> to pin a release
pi install npm:pi-posthorse                             # from npm
pi -e git:github.com/fitchmultz/pi-posthorse              # try it for one run without installing
```

Update with `pi update npm:pi-posthorse` or `pi update --extensions`; move a pinned Git install with `pi install git:github.com/fitchmultz/pi-posthorse@<new tag>`. Uninstall with `pi remove npm:pi-posthorse` (or the Git source you installed). Removing the package leaves `.pi/notes` and Pi's session history in place.

After installing or updating Posthorse, run `/reload` in existing Pi sessions or restart them to load the new version.

Keep exactly one copy loaded. `pi list` shows every package source; if an older entry such as `git:github.com/fitchmultz/pi-headroom.git` or a local checkout is still listed, `pi remove` it before installing the npm package, otherwise two copies register the same tools and compete for the same rollover hook.

## How it works

1. **Stable guidance.** Window behavior is part of the system prompt. There is no per-request meter to churn the prompt.
2. **One best-effort checkpoint.** While Pi compaction is enabled, one reminder may appear shortly before Pi's rollover line. A large turn, overflow, restart, or smaller model can reach rollover without it. Reminders are fingerprinted by window, context size, and reserve, so switching to a different context size gets a fresh reminder and stale ones are filtered from model input.
3. **`get_context_remaining`.** Reports the best available native estimate of tokens until Pi's automatic rollover line and until the model's hard limit. Pi's value is an estimate until the active model reports usage.
4. **`new_context`.** Requests an atomic rollover after the complete tool batch succeeds. An optional handoff is persisted and becomes the first state of the fresh window. If a sibling tool in the same batch fails, Pi does not commit the boundary; the checkpoint reminder still applies.
5. **Automatic rollover without summaries.** With a supported context budget and room for a recovery record, Posthorse claims Pi's automatic threshold and overflow trigger through `session_before_auto_compact`, before Pi resolves summarization credentials or prepares a summary. Oversized first turns and tool results can then roll over even without summarization credentials. Otherwise Pi's own compaction remains in control. Manual `/compact` is unchanged.
6. **Bounded recovery record.** The automatic handoff keeps direct user inputs, `ask_question` outcomes, visible coordination messages, and the trailing tool batch that no model has consumed yet (call arguments, bounded result text, and the entry ids to recover the rest). A clearly labeled, possibly stale older checkpoint comes last, after the current inputs and unseen results. Older assistant prose and consumed tool results are not treated as state. Newly submitted input stays separate and is saved after the boundary, not copied into the handoff.
7. **`notes` and `history`.** Notes live with the repository root, shared across linked worktrees. History searches normalized transcript text and returns stored images for a requested entry.

At turn end, Posthorse checks whether usage is in the reminder band before explicitly looking up the full branch. Context filtering skips its branch lookup when model input contains neither `posthorse-reminder` nor legacy `headroom-reminder` messages. History searches, reads, and recovery remain available with no new limits.

Automatic recovery is an emergency input record, not proof of progress. The fresh model is told to restore notes and todo state, inspect history when needed, and verify live state before taking stateful or external action.

## Settings

Posthorse follows Pi's effective `compaction` settings, including Pi's decision about whether project settings are trusted. Disabling `compaction.enabled` disables reminders and automatic rollover; `new_context` stays available.

The model's context window minus `compaction.reserveTokens` must leave at least 10,000 usable tokens. Below that (for example an 8K or 16K model with the default 16,384 reserve) Posthorse reports an unsupported configuration in the guidance and in `get_context_remaining`, turns automatic behavior off for that model, and leaves Pi's own compaction in place. Lower the reserve or use a larger model. The checkpoint reminder band is the last 10% of usable context, capped at 32,000 tokens, so a large reserve cannot trigger a reminder immediately in a fresh window.

Explicit and automatic handoffs are capped at 20,000 characters and half the active model's fresh operational capacity after prompt/tool overhead and any pending input, whichever is smaller. Oversized explicit handoffs are rejected with an instruction to save fuller state in notes; automatic rollover stays with Pi when no safe recovery record fits. When usage is not known yet, notes and history pages use the same model-aware limit.

Only one automatic compaction or rollover policy extension should be enabled at a time. Pi keeps the last non-cancel result from multiple handlers of the same hook, so load order would otherwise decide which policy wins.

## Tools

- `new_context({ handoff? })`
- `get_context_remaining()`
- `notes({ op, ... })`: `list`, `read` (paged; `offset` continues), `write` (empty content clears), `append` (one atomic newline-terminated record), `search` (excerpts centered on the match)
- `history({ op, ... })`: `search`, `read`; results carry native window ids, reads return stored images with the first page and the next character offset when text remains

Read pages, including returned images, shrink to the context that is actually left. Before usage is known, they reserve prompt/tool overhead and leave half the rest free. Unsafe pages are refused with the offset preserved; call `new_context` and retry.

`history search` puts matching original content before recovery material: handoffs, compaction and branch summaries, checkpoint reminders, and `notes`, `new_context`, and `history` calls/results. Ordinary prose or another tool call in the same assistant entry keeps its priority when that content matches. Every entry remains searchable; `history read` returns the complete normalized entry, including any recovery content omitted from a search excerpt.

Within each group, current-branch matches are newest first. With `all: true`, Posthorse searches every session file in the active Pi session directory, newest-modified sessions first and newest entries within each session; this is not a global timestamp sort. The result limit applies after priority, so newer echoes cannot displace older original matches. Entries copied by a fork are reported once.

Notes live in `.pi/notes/` at the repository root (the main checkout for a linked worktree, the current directory outside Git). Add the directory to `.gitignore` when the project should not track it.

## Data and privacy

- Posthorse makes no network requests.
- Notes are plaintext files under `.pi/notes`. They survive package removal and may be committed unless ignored.
- `history` with `all: true` scans nested JSONL files in the active Pi session directory, including subagent sessions.
- History can return user text, assistant text and thinking, tool arguments and results, handoffs, custom messages, and images. Direct shell entries Pi marked `excludeFromContext` come back as a placeholder only.
- Returned history content enters the currently selected model and provider context.
- Removing Posthorse does not remove notes or Pi session history.

## Compatibility

Reminders persisted by pi-headroom (`headroom-reminder`) are recognized alongside `posthorse-reminder` for deduplication, filtering, and recovery records. Notes, tool names, `.pi/notes`, and Pi's `context_window` entries are unchanged.

## Develop

```bash
npm ci
npm test
npm run check
PI_FORK=../pi scripts/integration.sh   # loads the real extension into the fork's test harness (fork built)
```

`npm run check` type-checks `index.ts` and the unit tests; the integration test runs inside the fork's harness. Unit tests cover reminder boundaries, skipped branch lookups, and legacy reminders; native integration tests cover rollover and history recovery. CI runs the unit tests on Node 22.19 and 24, `npm audit`, `npm pack --dry-run`, and the integration job against the pinned fork revision.
