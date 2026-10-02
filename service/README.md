# pi-handoff service

Headless, durable handoff prompt generation that survives the pi process exiting. One handoff request is one durable conversation: submit a session file plus a goal, wait for the generated prompt (or detach and collect it later), and resume pending generations after a crash. Generate-only — pi still owns review and session creation.

## Requirements

- Node >= 22.19 (`bin/pi-handoff.mjs` re-execs with `--experimental-strip-types` on runtimes without native type stripping).
- pi 1.0 credentials at `~/.pi/agent/auth.json`.

## Install / run

```bash
cd service && npm install
node bin/pi-handoff.mjs <command>
# or
npm run cli -- <command>
```

## Credentials

Models come from `~/.pi/agent/auth.json` (override with `PI_AUTH_FILE`). Built-in providers are `deepseek` and `opencode-go` (default `opencode-go`); both read `~/.pi/agent/auth.json`, and the `x-opencode-session` header opencode-go requires is supplied automatically per store. Override per call with `--provider`/`--model`. Requesting any other provider fails with a clear `Unknown provider` error.

## Storage

SQLite at `~/.pi/agent/handoff.sqlite` (override per command with `--store <path>`). One process owns the database at a time. If the process dies mid-generation, reopen against the same store and run `resume` to re-drive pending conversations.

## Command reference

```bash
# Generate and wait: prints the prompt to stdout.
node bin/pi-handoff.mjs submit --session /path/to/session.jsonl --goal "Port the auth flow to Hono"

# Detach: prints {"id":...,"conversationId":...} JSON, generation continues in the store.
node bin/pi-handoff.mjs submit --session /path/to/session.jsonl --goal "Port the auth flow" --detach

# Detach with explicit provider/model, custom store, JSON wait output.
node bin/pi-handoff.mjs submit --session sess.jsonl --goal "Fix flaky test" --provider deepseek --model deepseek-chat --store ~/handoff.sqlite --json

# Fetch a finished prompt by conversation id (from --detach output or list).
node bin/pi-handoff.mjs result 1
node bin/pi-handoff.mjs result 1 --store ~/handoff.sqlite

# List recorded handoffs (conversationId, status, goal); --json for machine output.
node bin/pi-handoff.mjs list
node bin/pi-handoff.mjs list --store ~/handoff.sqlite --json

# Re-drive pending generations after a crash, then list.
node bin/pi-handoff.mjs resume
node bin/pi-handoff.mjs resume --store ~/handoff.sqlite
```

Flags per command: `submit` takes `--session`, `--goal`, `--provider`, `--model`, `--store`, `--detach`, `--json`; `result` takes `--store`; `list` takes `--store`, `--json`; `resume` takes `--store`.

Exit codes: `0` on success; `submit` exits `1` when the generation settles unanswered (reason and `detail` on stderr); `result` exits `1` for unanswered and `2` when the conversation is pending or unknown.

## How it works

The session JSONL is parsed with the compaction-aware parser (`session-context.ts`): only the active branch path is kept, post-compaction entries plus the compaction summary are used, and content blocks are rendered to text the same way pi serializes conversations. The transcript and goal are assembled into a generation request from the shared `SYSTEM_PROMPT` (`../logic.ts`), and generation runs as a durable task in the SQLite-backed harness. Each conversation commits a `handoff.request` entry with the session file, goal, and timestamp, so `list` and `result` work after the store is reopened.

> [!NOTE]
> `submit` is idempotent per session file + goal, including across restarts: resubmitting the same pair returns the existing conversation instead of generating twice (the `requestId` index lives in the durable `handoff.request` entries, and `list` pages through every conversation regardless of count).

## Limitations

- Generate-only: no session creation, no `handoff` audit entry — copy the prompt into the new session yourself.
- No TUI/editor review step; what the model returns is what you get.
- Images in session content are ignored (text, thinking, and tool-call blocks only).
- Providers: built-ins are `deepseek` and `opencode-go` (default `opencode-go`); `x-opencode-session` is supplied automatically, `--provider`/`--model` override.
