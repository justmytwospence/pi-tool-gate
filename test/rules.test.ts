import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { MAX_RULES, RULES_FILE, loadRules, parseRules } from "../src/rules.ts";

test("top-level bullets are rules; indented lines continue them; fences are skipped", () => {
  const md = `# Rules

- Never edit generated files in \`dist/\`.
- Migrations are append-only:
  write a new one instead of editing.
* No new runtime dependencies.

\`\`\`
- not a rule
\`\`\`
1. Keep commits atomic.
`;
  expect(parseRules(md)).toEqual([
    "Never edit generated files in `dist/`.",
    "Migrations are append-only: write a new one instead of editing.",
    "No new runtime dependencies.",
    "Keep commits atomic.",
  ]);
});

/** Temp dirs for the four rules files, env pointed at them; `write` takes a dir and bullets. */
function setup() {
  const root = mkdtempSync("/tmp/rules-");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi");
  const cwd = path.join(root, "project");
  const dirs = {
    sharedProject: path.join(cwd, ".agents"),
    piProject: path.join(cwd, ".pi"),
    sharedUser: path.join(root, "xdg", "agents"),
    piUser: path.join(root, "pi"),
  };
  const write = (dir: string, rules: string[]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, RULES_FILE), rules.map((rule) => `- ${rule}\n`).join(""));
  };
  return { cwd, dirs, write };
}

test("rules come from .agents, .pi, ~/.config/agents and ~/.pi/agent in that order, without duplicates", () => {
  const { cwd, dirs, write } = setup();
  expect(loadRules(cwd)).toEqual([]);
  write(dirs.piUser, ["pi user", "shared user"]);
  write(dirs.sharedUser, ["shared user"]);
  write(dirs.piProject, ["pi project", "shared user"]);
  write(dirs.sharedProject, ["shared project", "pi project"]);
  expect(loadRules(cwd)).toEqual(["shared project", "pi project", "shared user", "pi user"]);
});

test("rules are capped at the maximum across files", () => {
  const { cwd, dirs, write } = setup();
  write(dirs.sharedProject, Array.from({ length: MAX_RULES - 1 }, (_, i) => `project ${i}`));
  write(dirs.sharedUser, ["user 0", "user 1"]);
  const rules = loadRules(cwd);
  expect(rules).toHaveLength(MAX_RULES);
  expect(rules.at(-1)).toBe("user 0");
});
