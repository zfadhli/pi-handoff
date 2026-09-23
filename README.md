# pi-handoff

Transfer context from the current session into a new, focused one.

```
/handoff <goal for the new thread>
```

1. Reads the compaction-aware branch and serializes it.
2. Streams a handoff prompt from the current model (abortable loader).
3. Opens it in an editor overlay; edit or accept.
4. Creates a new session linked via `parentSession` and leaves the prompt in the
   editor as a draft. You submit it.

The prompt ends with a `## Session History` chain (newest first) so the new
session can recover full context via `pi --session <path>`.

Rewrite of `@nicknisi/pi-handoff` 0.1.8 for pi >= 0.87. Fixes:

- Post-switch work runs in `newSession({ withSession })`. Pre-replacement `ctx`
  is invalidated after a session switch and throws on use, so the old
  `ctx.ui.setEditorText()` never reached the new session.
- Generation uses `ctx.modelRegistry.complete()` instead of
  `@nicknisi/pi-shared`'s provider shim, and surfaces errors via `ui.notify`.
- Branch context comes from `buildContextEntries()` +
  `sessionEntryToContextMessages()`, so compacted sessions hand off real
  context instead of only post-compaction entries.
- Guards on `ctx.mode === "tui"`.

Test: `npm test`. End-to-end: `pi -e ./index.ts`, then `/handoff <goal>`.
