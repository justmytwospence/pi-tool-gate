import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { askApproval } from "../src/prompt.ts";
import { callView, formatBash } from "../src/view.ts";

describe("formatBash", () => {
  test("short commands are left alone", () => {
    expect(formatBash("git add -A && git commit -m wip")).toBe("git add -A && git commit -m wip");
  });

  test("long commands go one step per line, operators kept", () => {
    const cmd = "cd /Users/me/Projects/app && npm ci --ignore-scripts | tee install.log; npm test -- --run || echo 'tests failed; see log'";
    expect(formatBash(cmd)).toBe(
      "cd /Users/me/Projects/app &&\n  npm ci --ignore-scripts |\n  tee install.log;\n  npm test -- --run ||\n  echo 'tests failed; see log'",
    );
  });

  test("quotes, subshells, redirects and comments are not split", () => {
    const cmd = `docker logs --since 15m bluesky-pds 2>&1 | python3 -c "import sys; print(sys.stdin.read()[-2000:])" >| out.txt # a; b && c`;
    expect(formatBash(cmd)).toBe(
      `docker logs --since 15m bluesky-pds 2>&1 |\n  python3 -c "import sys; print(sys.stdin.read()[-2000:])" >| out.txt # a; b && c`,
    );
    const sub = "echo $(git rev-parse HEAD && git status --porcelain | wc -l) (cd /tmp && ls -la /var/folders/some/where)";
    expect(formatBash(sub)).toBe(sub);
  });

  test("multi-line scripts and heredocs are left alone", () => {
    const heredoc = "cat <<EOF > /tmp/some/long/path/file.txt && echo done && echo again && echo once more for length\nx\nEOF";
    expect(formatBash(heredoc)).toBe(heredoc);
  });
});

describe("callView", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tool-gate-"));
  writeFileSync(path.join(dir, "a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");

  test("an edit is a diff against the file, with real line numbers", async () => {
    const v = await callView("edit", { path: "a.ts", edits: [{ oldText: "const b = 2;", newText: "const b = 20;" }] }, dir);
    expect(v.subject).toBe("a.ts");
    expect(v.body.kind).toBe("diff");
    expect(v.body.text).toMatch(/^-2 const b = 2;$/mu);
    expect(v.body.text).toMatch(/^\+2 const b = 20;$/mu);
  });

  test("an edit that does not match falls back to the edit text alone", async () => {
    const v = await callView("edit", { path: "a.ts", edits: [{ oldText: "nope", newText: "yes" }] }, dir);
    expect(v.note).toMatch(/no exact match/u);
    expect(v.body.text).toMatch(/nope/u);
    expect(v.body.text).toMatch(/yes/u);
  });

  test("a write to a new file is code in the file's language; an overwrite is a diff", async () => {
    const fresh = await callView("write", { path: "b.py", content: "print(1)\nprint(2)\n" }, dir);
    expect(fresh.note).toBe("new file, 2 lines");
    expect(fresh.body).toEqual({ kind: "code", lang: "python", text: "print(1)\nprint(2)\n" });
    const over = await callView("write", { path: "a.ts", content: "const a = 1;\n" }, dir);
    expect(over.note).toBe("overwrites");
    expect(over.body.kind).toBe("diff");
  });

  test("other tools show their input as JSON", async () => {
    const v = await callView("deploy", { env: "prod", force: true }, dir);
    expect(v.body).toEqual({ kind: "code", lang: "json", text: '{\n  "env": "prod",\n  "force": true\n}' });
  });
});

describe("askApproval in the terminal UI", () => {
  initTheme("dark");

  async function show(approval: Parameters<typeof askApproval>[1], keys: string[], rows = 40) {
    let frames: string[][] = [];
    const ctx: any = {
      mode: "tui",
      ui: {
        custom: (factory: any) =>
          new Promise((resolve) => {
            const tui = { terminal: { rows, columns: 100 }, requestRender: () => undefined };
            const kb = { matches: (data: string, id: string) => id === "app.tools.expand" && data === "\x0f" };
            const theme = { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t, italic: (t: string) => t };
            const c = factory(tui, theme, kb, resolve);
            frames.push(c.render(100).map(stripTerminalSequences));
            for (const k of keys) {
              c.handleInput(k);
              frames.push(c.render(100).map(stripTerminalSequences));
            }
          }),
        select: async () => "select fallback",
      },
    };
    const choice = await askApproval(ctx, approval, "title");
    return { choice, frames };
  }

  const view = { tool: "bash", subject: "", body: { kind: "code" as const, lang: "bash", text: "git push --force origin main" } };

  test("renders the call, why it was held and the agent's case; Enter picks the highlighted option", async () => {
    const { choice, frames } = await show(
      { view, held: "force-pushes main/master", agentCase: "The **rebase** is needed:\n\n- one\n- two", options: ["Allow once", "Block"] },
      ["\x1b[B", "\r"],
    );
    const text = frames[0]!.join("\n");
    expect(text).toMatch(/Allow\? bash/u);
    expect(text).toMatch(/git push --force origin main/u);
    expect(text).toMatch(/Held: force-pushes main\/master/u);
    expect(text).toMatch(/Agent:/u);
    expect(text).toMatch(/The rebase is needed:/u);
    expect(text).toMatch(/one/u);
    expect(text).not.toMatch(/expand/u);
    expect(choice).toBe("Block");
  });

  test("Esc blocks", async () => {
    const { choice } = await show({ view, options: ["Allow once", "Block"] }, ["\x1b"]);
    expect(choice).toBe("Block");
  });

  test("a long body is clamped until ctrl+o expands it", async () => {
    const long = { ...view, body: { kind: "code" as const, lang: "bash", text: Array.from({ length: 50 }, (_, i) => `echo ${i}`).join("\n") } };
    const { frames } = await show({ view: long, options: ["Allow once", "Block"] }, ["\x0f", "\r"], 20);
    const collapsed = frames[0]!.join("\n");
    expect(collapsed).toMatch(/echo 7\b/u);
    expect(collapsed).not.toMatch(/echo 8\b/u);
    expect(collapsed).toMatch(/42 more lines/u);
    expect(collapsed).toMatch(/ expand/u);
    expect(frames[1]!.join("\n")).toMatch(/echo 49/u);
  });

  test("outside the terminal UI it falls back to a plain select", async () => {
    const ctx: any = { mode: "rpc", ui: { custom: async () => undefined, select: async (title: string) => `asked: ${title}` } };
    expect(await askApproval(ctx, { view, options: ["Allow once", "Block"] }, "Allow? bash: x")).toBe("asked: Allow? bash: x");
  });
});
