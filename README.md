# pi-tool-gate

A [pi](https://pi.dev) extension that auto-approves tool calls, so you are only pulled in when a
call is risky and the agent could not find a way around it.

1. **Clear cases, no model call.** Read-only calls run: tools with a `readOnlyHint`, the built-in
   `read`/`grep`/`find`/`ls`, bash made only of read-only programs (`ls`, `rg`, `git status|diff|log`,
   `npm ls`, ... with no redirects or command substitution), and the tools in `allowTools`.
   A short list always goes to you: `sudo`, deleting the project, your home directory or anything
   outside it, force-pushing main/master, `curl … | sh`, touching credential files (`.env*`, `~/.ssh`,
   `auth.json`, keys), and writes outside the project and temp directories.
2. **Jev for the gray zone.** Edits, writes, other bash commands, and MCP or extension tools without
   a read-only hint go to [Jev](https://docs.typesafe.ai) in one request (about 250 ms): is the call
   in scope for your request, irreversible, does it affect things outside the working copy, how
   risky is it (0-3), and does it break any project rule. Allowed when risk < 1.5, irreversible <
   0.5, external < 0.5, in scope >= 0.5 and every rule < 0.7.
3. **One push-back, then you.** The first held call in a user turn is blocked with a reason the
   agent sees (the failed checks and the quoted rule) and an instruction to find a reversible,
   in-scope alternative or explain why the exact action is needed. Later holds in the same turn ask
   you: allow once, allow similar for this session (same program and subcommand, or same
   directory), block, or block with a message. Without a UI (subagents, print and JSON modes),
   they are blocked.

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
  "thresholds": { "risk": 1.5, "irreversible": 0.5, "externalEffect": 0.5, "inScope": 0.5, "rule": 0.7 },
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
```
