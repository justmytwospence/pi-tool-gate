import { expect, test } from "vitest";
import toolGate, { DEFAULT_CONFIG } from "../src/index.ts";
import { assistantEntry, fakeJev, harness, userEntry } from "./harness.ts";

const safe = {
  in_scope: { type: "bool", probability: 0.95 },
  irreversible: { type: "bool", probability: 0.05 },
  remote_change: { type: "bool", probability: 0.02 },
  exfiltration: { type: "bool", probability: 0.01 },
  impact: { type: "score", score: 1, confidence: 0.9 },
};
const risky = {
  ...safe,
  requested: { type: "bool", probability: 0.1 },
  remote_change: { type: "bool", probability: 0.95 },
  impact: { type: "score", score: 2.2, confidence: 0.8 },
};

function setup(answers: any, ctxOverrides: Record<string, unknown> = {}) {
  const h = harness();
  toolGate(h.pi);
  const jev = fakeJev(() => answers);
  const ctx = h.ctx({
    modelRegistry: jev.registry,
    sessionManager: { getBranch: () => [userEntry("Fix the failing test"), assistantEntry("I'll rerun the tests.")] },
    ...ctxOverrides,
  });
  return { h, jev, ctx };
}

const call = (toolName: string, input: Record<string, unknown>, id = "t1") => ({ type: "tool_call", toolCallId: id, toolName, input });

test("read-only calls pass without Jev", async () => {
  const { h, jev, ctx } = setup(safe);
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  expect(await h.emit("tool_call", call("bash", { command: "git status && rg foo" }), ctx)).toBeUndefined();
  expect(await h.emit("tool_call", call("read", { path: "src/a.ts" }), ctx)).toBeUndefined();
  expect(jev.calls).toHaveLength(0);
  expect(ctx.ui.status.get("tool-gate")).toBe("gate: 2 auto · 0 pushed back · 0 asked");
});

test("Jev allows a safe gray-zone call and reports its usage on the result", async () => {
  const { h, jev, ctx } = setup(safe);
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  expect(await h.emit("tool_call", call("bash", { command: "npm test" }), ctx)).toBeUndefined();
  expect(jev.calls[0]?.state).toMatchObject({ user_requests: ["Fix the failing test"], recent_intent: "I'll rerun the tests.", tool_call: { tool: "bash", arguments: "npm test" } });
  const result: any = await h.emit("tool_result", { type: "tool_result", toolCallId: "t1", toolName: "bash", content: [], isError: false }, ctx);
  expect(result.usage.input).toBe(300);
  expect(h.entries[0]).toMatchObject({ customType: "tool-gate:decision", data: { action: "allow" } });
});

test("a held call is pushed back to the agent; retrying it asks the user", async () => {
  const { h, ctx } = setup(risky);
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  const first: any = await h.emit("tool_call", call("bash", { command: "npm publish" }), ctx);
  expect(first.block).toBe(true);
  expect(first.reason).toMatch(/changes remote or shared state/u);
  expect(first.reason).toMatch(/make the identical call again/u);
  expect(ctx.ui.selects).toHaveLength(0);
  expect(ctx.ui.status.get("tool-gate")).toBe("gate: 0 auto · 1 pushed back · 0 asked");

  // The retry goes to the user, whose options carry no message prompt.
  ctx.ui.selectAnswers.push("Allow similar for this session");
  expect(await h.emit("tool_call", call("bash", { command: "npm publish" }, "t2"), ctx)).toBeUndefined();
  expect(ctx.ui.selects[0]?.options).toEqual(["Allow once", "Allow similar for this session", "Block"]);
  // The grant covers the same program and subcommand without asking again.
  expect(await h.emit("tool_call", call("bash", { command: "npm publish --dry-run" }, "t3"), ctx)).toBeUndefined();
  expect(ctx.ui.selects).toHaveLength(1);

  // A different held call is pushed back on its own first.
  const other: any = await h.emit("tool_call", call("bash", { command: "git push origin feature" }, "t4"), ctx);
  expect(other.block).toBe(true);
  expect(ctx.ui.selects).toHaveLength(1);
  // A workaround in the same family that is still held goes to the user.
  ctx.ui.selectAnswers.push("Block");
  const declined: any = await h.emit("tool_call", call("bash", { command: "git push origin feature:other" }, "t5"), ctx);
  expect(declined.reason).toMatch(/The user declined this call/u);
  expect(ctx.ui.selects).toHaveLength(2);

  // A new user turn starts over.
  await h.emit("before_agent_start", { prompt: "y" }, ctx);
  const again: any = await h.emit("tool_call", call("bash", { command: "git push origin feature" }, "t6"), ctx);
  expect(again.block).toBe(true);
  expect(ctx.ui.selects).toHaveLength(2);
});

test("project rules are judged and quoted back", async () => {
  const { h, jev, ctx } = setup({ ...safe, "rule::0": { type: "bool", probability: 0.95 } });
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const dir = mkdtempSync("/tmp/gate-");
  mkdirSync(`${dir}/.pi`);
  writeFileSync(`${dir}/.pi/tool-gate-rules.md`, "- Never edit files under dist/.\n");
  ctx.cwd = dir;
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  const result: any = await h.emit("tool_call", call("edit", { path: "dist/index.js", edits: [] }), ctx);
  expect(jev.calls[0]?.questions["rule::0"]?.instructions).toMatch(/Never edit files under dist/u);
  expect(result.reason).toMatch(/"Never edit files under dist\/\."/u);
});

test("always-ask calls skip Jev, are pushed back first, then go to the user", async () => {
  const { h, jev, ctx } = setup(safe);
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  const first: any = await h.emit("tool_call", call("bash", { command: "git push --force origin main" }), ctx);
  expect(first.block).toBe(true);
  expect(first.reason).toMatch(/force-pushes main\/master/u);
  expect(ctx.ui.selects).toHaveLength(0);
  ctx.ui.selectAnswers.push("Allow once");
  expect(await h.emit("tool_call", call("bash", { command: "git push --force origin main" }, "t2"), ctx)).toBeUndefined();
  expect(ctx.ui.selects[0]?.options).toEqual(["Allow once", "Block"]);
  expect(jev.calls).toHaveLength(0);
});

test("without UI, a retried hold is blocked", async () => {
  const { h, ctx } = setup(risky, { hasUI: false });
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  const first: any = await h.emit("tool_call", call("bash", { command: "npm publish" }), ctx);
  expect(first.reason).toMatch(/make the identical call again/u);
  const second: any = await h.emit("tool_call", call("bash", { command: "npm publish" }, "t2"), ctx);
  expect(second.block).toBe(true);
  expect(second.reason).toMatch(/no user to approve it/u);
});

test("with push-back off, holds go straight to the user", async () => {
  const { h, ctx } = setup(risky);
  DEFAULT_CONFIG.pushBack = false;
  try {
    await h.emit("before_agent_start", { prompt: "x" }, ctx);
    ctx.ui.selectAnswers.push("Allow once");
    expect(await h.emit("tool_call", call("bash", { command: "npm publish" }), ctx)).toBeUndefined();
    expect(ctx.ui.selects).toHaveLength(1);
  } finally {
    DEFAULT_CONFIG.pushBack = true;
  }
});

test("when Jev is unavailable, Pi's tool hints decide", async () => {
  const h = harness({ tools: [{ name: "mcp__notes__search", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }] });
  toolGate(h.pi);
  const jev = fakeJev(() => ({ stopReason: "error", errorMessage: "No API key for provider: typesafe", answers: {} }));
  const ctx = h.ctx({ modelRegistry: jev.registry });
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  expect(await h.emit("tool_call", call("mcp__notes__search", { q: "x" }), ctx)).toBeUndefined();
  ctx.ui.selectAnswers.push("Block");
  const result: any = await h.emit("tool_call", call("bash", { command: "npm test" }, "t2"), ctx);
  expect(result.block).toBe(true);
  expect(ctx.ui.notes[0]?.message).toMatch(/no classifier credentials/u);

  const headless = setup({ stopReason: "error", errorMessage: "x", answers: {} }, { hasUI: false });
  expect(await headless.h.emit("tool_call", call("bash", { command: "npm test" }), headless.ctx)).toBeUndefined();
});

test("/gate off disables the gate for the session", async () => {
  const { h, jev, ctx } = setup(risky);
  await h.commands.get("gate").handler("off", ctx);
  expect(await h.emit("tool_call", call("bash", { command: "npm publish" }), ctx)).toBeUndefined();
  expect(jev.calls).toHaveLength(0);
});
