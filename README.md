# pi-handoff

Transfer context from the current session into a new, focused one.

```
/handoff <goal for the new thread>
```

`/handoff` reads the active branch, summarizes what matters for the task you name, and drops the result into a fresh session as an editable draft. Compaction is lossy; handoff is a deliberate, reviewable prompt you can edit before the next agent sees it.

## Install

```bash
pi install git:github.com/zfadhli/pi-handoff
```

Pin a tag or commit for reproducible installs:

```bash
pi install git:github.com/zfadhli/pi-handoff@v0.2.0
```

Or clone and install locally:

```bash
git clone git@github.com:zfadhli/pi-handoff.git
pi install /path/to/pi-handoff
```

Not published to npm.

Requires pi >= 0.87.

## Usage

1. Run `/handoff` with the goal for the new thread.
2. The extension reads the compaction-aware branch and serializes it.
3. The current model streams a handoff prompt behind an abortable loader.
4. The prompt opens in an editor overlay — edit or accept.
5. A new session is created, linked to the previous one via `parentSession`, and the prompt is left in the editor as a draft. You submit it.

The prompt ends with a `## Session History` chain, newest first, so the new session can recover full context:

```
## Session History
Previous sessions (most recent first):
1. /home/user/.pi/agent/sessions/--home-user-app--/2026-09-23T14-19-50-704Z_01a0cea3.jsonl
2. /home/user/.pi/agent/sessions/--home-user-app--/2026-09-23T09-02-11-118Z_7ff21b90.jsonl

Use `pi --session <path>` to review any session if needed.
```

## How it works

| Step | Implementation |
|---|---|
| Branch context | `sessionManager.buildContextEntries()` + `sessionEntryToContextMessages()`, so a compacted session hands off real context rather than only post-compaction entries. |
| Prompt generation | `ctx.modelRegistry.complete()` with the active model, abortable via the loader's signal. |
| Session chain | Each session file's header is read with `pi.exec('head', ['-1', file])`; ancestors are walked via `parentSession` with cycle protection. |
| Session creation | `ctx.newSession({ parentSession, withSession })`. |

> [!IMPORTANT]
> Pre-replacement `ctx` is invalidated after a session switch, and operations on it throw. All session-bound UI work happens inside the `withSession` callback, using the replacement context.

Errors during generation surface via `ctx.ui.notify` instead of failing silently. Cancelling the loader, the editor, or the new session aborts cleanly.

### Command guard

The command requires interactive mode (`ctx.mode === 'tui'`) and a selected model. Both are checked before any work starts.

## Development

```bash
npm test                     # node:test unit tests for the session-chain helpers
pi -e ./index.ts             # load the extension in a live session
```

Then run `/handoff <goal>` — this is the end-to-end check, since the extension drives a TUI editor overlay and a session switch.

Formatting is [Biome](https://biomejs.dev): 2-space indent, single quotes, semicolons as needed, 100-column width.

```
biome format --write .
```

## Layout

```
pi-handoff/
├── index.ts              # command handler: read branch, generate, edit, switch session
├── logic.ts              # pure helpers: collectSessionChain, sessionHistorySection
├── tests/handoff.test.ts # unit tests for the helpers
├── biome.json
└── package.json
```

`logic.ts` uses type-only imports so the tests load without pi's extension alias resolution.
