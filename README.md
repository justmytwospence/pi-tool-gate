# pi-tool-gate

A [pi](https://pi.dev) extension that auto-approves tool calls, so you are only pulled in when a
call is risky and the agent could not find a way around it.

1. **Clear cases, no model call.** Read-only calls run: tools with a `readOnlyHint`, the built-in
   `read`/`grep`/`find`/`ls`, bash made only of read-only programs (`ls`, `rg`, `git status|diff|log`,
   `npm ls`, `curl`/`wget` GETs, `docker ps|logs|inspect`, `docker compose ps|logs|config`,
   `kubectl get|describe|logs`, `gh pr|issue|run view|list`, `systemctl status`, `journalctl`,
   `sqlite3 -readonly`, `dig`, ... with no writing redirects or command substitution), and the tools
   in `allowTools`. A short list always goes to you: `sudo`, deleting the project, your home
   directory or anything outside it, force-pushing main/master, `curl … | sh`, touching credential
   files (`.env*`, `~/.ssh`, `auth.json`, keys), and writes outside the project and temp directories.
2. **Jev for the gray zone, holding only on confident danger.** Edits, writes, other bash commands,
   and MCP or extension tools without a read-only hint go to [Jev](https://docs.typesafe.ai) in one
   request (about 250 ms). A call is held only when Jev is confident it is dangerous:
   - it cannot be undone (>= 0.9),
   - it changes remote or shared state (>= 0.85: push, deploy, post, modify a cloud resource)
     and you did not directly ask for it (< 0.8),
   - it sends secrets or private data off the machine (>= 0.8),
   - its impact if unwanted is 2.5 or more of 3 (lost data, leaked secrets, broken production),
   - it is clearly unrelated to your request (< 0.1) and could do harm (impact >= 1.5),
   - or it breaks a project rule (>= 0.7).

   Doubt alone never holds a call: an investigation command Jev is unsure is on-task still runs.
   These bars follow the published Jev gates (pi-warden holds at 0.9 irreversible, pi-jev at 0.9
   destructive, 0.7 exfiltration, and 2.5 impact). Jev sees your last three messages, so a reply
   like "ok, I did" keeps its context.
3. **One push-back, then you.** The first held call in a user turn is blocked with a reason the
   agent sees (the failed checks and the quoted rule) and an instruction to find a reversible,
   in-scope alternative or explain why the exact action is needed. Later holds in the same turn ask
   you: allow once, allow similar for this session (same program and subcommand, or same
   directory), block, or block with a message. Without a UI (print and JSON modes) they are
   blocked; pi-subagents forwards a subagent's question to you.

Jev runs through Pi's own classifier models (`ctx.modelRegistry.classify`), so it uses Pi's
credentials (`TYPESAFE_API_KEY` for the `typesafe` provider) and its token usage is added to the
gated tool's result. When Jev is unavailable, the gate asks you about calls Pi's tool hints flag
(the confirmation rule from Pi's extension docs) and allows the rest; without a UI it allows them.
Requires Pi 0.99 or newer for classifier models.

## Project rules

Each top-level bullet in `<project>/.pi/tool-gate-rules.md` and `~/.pi/agent/tool-gate-rules.md`
is a rule (at most 30), checked on every judged call:

```markdown
- Migrations are append-only: never edit an existing migration, add a new one.
- No new runtime dependencies without asking.
```

## Commands

- `/gate` or `/gate status`: counts, Jev model, rules and session grants.
- `/gate on`, `/gate off`: turn the gate on or off for this session.

The footer status shows `gate: N auto · M held`. Every judged call is recorded in the session as a
`tool-gate:decision` entry (scores, action, latency, tokens; never sent to the model), for tuning
thresholds.

## Settings

`~/.pi/agent/tool-gate.json`, with `<project>/.pi/tool-gate.json` merged on top:

```json
{
  "enabled": true,
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 3000 },
  "thresholds": {
    "irreversible": 0.9, "remoteChange": 0.85, "requested": 0.8, "exfiltration": 0.8,
    "impact": 2.5, "offTask": 0.1, "offTaskImpact": 1.5, "rule": 0.7
  },
  "allowTools": ["codemode", "todo", "web_search"],
  "readOnlyCommands": ["bd"],
  "pushBack": true
}
```

`allowTools` replaces the default list (see `src/index.ts`). `codemode` is allowed because each
tool its scripts call is gated on its own.

## Development

```sh
npm run check   # typecheck and unit tests
npm run eval    # labeled calls against live Jev through the installed Pi (needs TYPESAFE_API_KEY)
GATE_REPLAY=decisions.json npm run eval -- eval/replay.eval.ts   # replay recorded decisions
```
