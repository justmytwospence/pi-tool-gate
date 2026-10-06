# pi-tool-gate

A [pi](https://pi.dev) extension that auto-approves tool calls, so you are only pulled in when a
call is risky and the agent could not find a way around it.

1. **Clear cases, no model call.** Read-only calls run: tools with a `readOnlyHint`, the built-in
   `read`/`grep`/`find`/`ls`, bash made only of read-only programs (`ls`, `rg`, `git status|diff|log`,
   `npm ls`, `curl`/`wget` GETs, `docker ps|logs|inspect`, `docker compose ps|logs|config`,
   `kubectl get|describe|logs`, `gh pr|issue|run view|list`, `systemctl status`, `journalctl`,
   `sqlite3 -readonly`, `dig`, ... with no writing redirects or command substitution), and the tools
   in `allowTools`. A short list is always held, whatever Jev says: `sudo`, deleting `/`, a
   top-level directory, your home directory, the project, or a parent of either, force-pushing
   main/master, `curl … | sh`, and touching files that hold live secrets (`.env*` but not
   `.env.example`, private SSH keys, `auth.json`, `.aws/credentials`, `.netrc`, `*.pem`/`*.key`;
   not SSH config, public keys or `.npmrc`). Writes and deletes elsewhere outside the project go to Jev.
2. **Jev for the gray zone, calibrated like Claude Code's auto mode.** Edits, writes, other bash
   commands, and MCP or extension tools without a read-only hint go to
   [Jev](https://docs.typesafe.ai) in one request (about 250 ms). Calls are allowed by default.
   Unless you asked for the action, or said yes when the agent offered it (Claude Code's "named"
   exception, >= 0.8), a call is held when Jev is confident that:
   - it cannot be undone (>= 0.9),
   - it does something other people see or depend on (>= 0.85: deploy, publish, post a message,
     open or merge a PR, create a public repo, modify a shared or cloud resource); pushing commits
     to a git branch and maintaining your own machines over ssh do not count,
   - its impact if unwanted is 2.5 or more of 3 (lost data, leaked secrets, broken production),
   - or it is clearly unrelated to your request (< 0.1) and would do significant damage (impact >= 2).

   Whatever you said, a call is held when it sends secrets or private data off the machine
   (>= 0.8) or breaks a project rule (>= 0.7). Jev also sees the agent's message your newest one
   replies to, so "yes" to "Want me to push and sync?" counts as asking for the push and sync.

   Doubt alone never holds a call: an investigation command Jev is unsure is on-task still runs.
   These bars follow the published Jev gates (pi-warden holds at 0.9 irreversible, pi-jev at 0.9
   destructive, 0.7 exfiltration, and 2.5 impact). Jev sees your last three messages, so a reply
   like "ok, I did" keeps its context.
3. **Jev pushes back, the agent works around it or makes its case, then you.** A held call is
   blocked automatically. The agent sees Jev's explanation (which checks failed and how sure it
   is, plus any quoted rules) and a suggested workaround, which Jev picks in a second request
   made only for held calls: preview it with a dry run, narrow it, make it reversible, keep it
   local, follow the project rule, skip it, or "no workaround, this is the user's call". The
   agent then either does the job another way, drops the call, or makes its case: a short message
   saying why this exact call is needed, sent with the identical call. That retry, or another
   held call of the same family (same program and subcommand, or same directory) in the same user
   turn, is put to you with Jev's reasons and the agent's case: allow once, allow similar for this
   session, or block. Without a UI (print and JSON modes) the retry is blocked; pi-subagents
   forwards a subagent's question to you. Set `"pushBack": false` to be asked straight away.

In Pi's terminal UI the question shows the call itself, highlighted: a long bash command one step
per line (only whitespace changes), an edit or overwrite as a diff against the file with line
numbers, a new file in its language, any other tool's input as JSON. Below it are why it was held
and the agent's case, rendered as Markdown. Long parts are cut short; ctrl+o expands them, Esc
blocks. RPC clients and forwarded subagent questions get a plain one-line summary instead.

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

The footer status shows `gate: N auto · P pushed back · M asked`. Every judged call is recorded in the session as a
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
    "impact": 2.5, "offTask": 0.1, "offTaskImpact": 2, "rule": 0.7
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
