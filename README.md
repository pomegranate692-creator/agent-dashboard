# Agent Dashboard

A **read-only**, real-time view of the Claude Code sessions and subagents already running on this Mac.
It observes; it never starts, steers, stops or reconfigures anything, and never writes to `~/.claude`.

## Start

```bash
cd ~/agent-dashboard
node server/index.js            # or: npm start
# → http://localhost:4317        (use --port N to change; binds to 127.0.0.1 only)
```

No dependencies, no build step (Node ≥ 18; verified on Node 24). Tests: `npm test`.

## What it observes (verified on Claude Code 2.1.x)

| Source | Used for |
|---|---|
| `~/.claude/sessions/<pid>.json` (live-session registry; same data `claude agents --json` prints) | which sessions have a running process, and whether it is **busy** (working) or **idle** |
| `~/.claude/projects/*/<sessionId>.jsonl` | prompts, replies, tool calls + results, errors, API errors |
| `~/.claude/projects/*/<sessionId>/subagents/agent-<id>.{jsonl,meta.json}` | subagent runs; `meta.toolUseId` links each run to the parent's `Agent` tool call |
| `<task-notification>` records in the parent transcript | completion of *background* subagents |
| `agent_listing_delta` records + agent definition folders | configured agent types (see below) |

Your agents: you have **no custom agent definition files** (checked `~/.claude/agents`, every project's
`.claude/agents`, and enabled plugins). Sessions are offered Claude Code's six built-in types
(`claude`, `claude-code-guide`, `Explore`, `general-purpose`, `Plan`, `statusline-setup`). The dashboard lists
those as *configured types*, and separately shows *running instances* (sessions and the subagents they spawned)
and *historical activity*. If you add agent files, they appear automatically.

## Reading the UI

- **Rail (left)**: sessions grouped Working now / Open, idle / Recent history, then configured agent types.
- **Map**: hub → project folders → sessions → subagents. Double-click a session to open its **Flow**.
- **Flow**: prompt → Claude reply → tool calls, with subagents branching off to their own tool calls.
  Replay scrubs through a session's history (amber banner = not live).
- **Inspector (right)**: full prompt/output/error text, fetched on demand from the transcript.
- **Recent activity (bottom)**: observable actions across sessions, newest first.
- Header: connection state, live counts, *Needs attention*, and *How this is observed*.

States are never guessed: a tool call without a result is **Running** only while its session is registered as
working, otherwise **No result recorded**. If the browser loses the server, everything is marked
**Unknown / Visibility lost** instead of being assumed finished.

## Limitations

- Transcripts are written slightly after events happen; expect ~1–2 s lag.
- A pending *permission prompt* is not visible in any file; only questions Claude asked you
  (`AskUserQuestion`, `ExitPlanMode`) are flagged as "waiting for you".
- Sessions that don't write to `~/.claude` (cloud sessions, other machines) are invisible.
- Private reasoning blocks are never read or shown. API keys/tokens are masked in previews.
- No token costs are shown: dollar costs aren't recorded in transcripts and aren't estimated. Token counts shown
  for subagents are the totals Claude Code itself reported.
- `--agents` CLI-defined agents are session-only and not saved to disk, so they only appear if a session listed them.

## Testing without touching real data

`scripts/fixture.js` + `scripts/simulate-live.js` write synthetic transcripts to a temp folder:

```bash
node scripts/simulate-live.js /tmp/ad-fixture &
node server/index.js --root /tmp/ad-fixture --port 4318   # shows a FIXTURE DATA banner
```
