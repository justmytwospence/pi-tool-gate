// pi-tool-gate: auto-approves tool calls. Fixed rules settle the clear cases (read-only calls run,
// a short list of dangerous ones always goes to you); Jev, through Pi's own classifier models,
// judges the gray zone. A held call is first blocked with a reason the agent sees, so it can find
// another way; only if the agent retries the same call is it put to you. Project rules in `.pi/tool-gate-rules.md` are checked on every
// judged call. Without Jev the gate falls back to Pi's tool hints.
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { alwaysAskBash, alwaysAskPath, bashKey, isCredentialPath, expandHome, isReadOnlyBash } from "./bash.ts";
import { loadConfig } from "./config.ts";
import { type ClassifierUsage, type JevConfig, askJev } from "./jev.ts";
import { DEFAULT_THRESHOLDS, type Thresholds, judgeQuestions, judgeState, steerReason, verdict } from "./judge.ts";
import { loadRules } from "./rules.ts";
import { clip, clipTail, recentTexts, recentUserMessages } from "./transcript.ts";

export interface GateConfig extends Record<string, unknown> {
  enabled: boolean;
  jev: JevConfig;
  thresholds: Thresholds;
  /** Tools that never need a decision (they change nothing, or gate their own nested calls). */
  allowTools: string[];
  /** Extra programs treated as read-only in bash. */
  readOnlyCommands: string[];
  /** Block a held call once with a reason for the agent before asking you; a retry asks you. */
  pushBack: boolean;
}

export const DEFAULT_CONFIG: GateConfig = {
  enabled: true,
  jev: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 3_000 },
  thresholds: DEFAULT_THRESHOLDS,
  allowTools: [
    "codemode", "tool_search", "todo", "ask_user_question", "plan_mode_question", "plan_mode_complete",
    "web_search", "fetch_content", "get_search_content", "code_search", "radius_web_search", "web_enable",
    "bg_status", "bg_logs", "bg_result", "bg_wait", "subagents_enable",
  ],
  readOnlyCommands: [],
  pushBack: true,
};

const STATUS_KEY = "tool-gate";
const BUILTIN_READ = new Set(["read", "grep", "find", "ls"]);

type Plan =
  | { kind: "allow"; why: string }
  | { kind: "ask"; reasons: string[]; key: string }
  | { kind: "judge"; args: string; key: string };

interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export default function toolGate(pi: ExtensionAPI) {
  let config: GateConfig = DEFAULT_CONFIG;
  let sessionOn = true;
  let auto = 0;
  let held = 0;
  let pushedBack = 0;
  /** Calls (and families of calls) pushed back this user turn; a retry goes to the user. */
  const pushedBackThisTurn = new Set<string>();
  const allowSimilar = new Set<string>();
  const pendingUsage = new Map<string, ClassifierUsage>();
  let gitInfo: Promise<{ branch: string; dirty: boolean } | undefined> | undefined;
  let dialogs: Promise<unknown> = Promise.resolve();
  let warnedUnavailable = false;

  const annotations = (tool: string): Annotations | undefined => {
    const info = pi.getAllTools().find((t) => t.name === tool) as { annotations?: Annotations } | undefined;
    return info?.annotations;
  };

  const status = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      STATUS_KEY,
      sessionOn && config.enabled ? `gate: ${auto} auto · ${pushedBack} pushed back · ${held} asked` : "gate: off",
    );
  };

  const git = (cwd: string) => {
    gitInfo ??= (async () => {
      try {
        const branch = await pi.exec("git", ["-C", cwd, "branch", "--show-current"], { timeout: 2_000 });
        if (branch.code !== 0) return undefined;
        const dirty = await pi.exec("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=no"], { timeout: 2_000 });
        return { branch: branch.stdout.trim() || "(detached)", dirty: dirty.stdout.trim().length > 0 };
      } catch {
        return undefined;
      }
    })();
    return gitInfo;
  };

  const plan = async (tool: string, input: Record<string, unknown>, cwd: string): Promise<Plan> => {
    if (config.allowTools.includes(tool)) return { kind: "allow", why: "allow list" };
    if (tool === "bash") {
      const command = String(input.command ?? "");
      const reasons = alwaysAskBash(command, cwd, (await git(cwd))?.branch);
      if (reasons.length) return { kind: "ask", reasons, key: `fixed:${reasons.join("; ")}` };
      if (isReadOnlyBash(command, config.readOnlyCommands)) return { kind: "allow", why: "read-only command" };
      return { kind: "judge", args: clip(command, 6_000), key: `bash:${bashKey(command)}` };
    }
    if (tool === "edit" || tool === "write") {
      const file = String(input.path ?? "");
      const reasons = alwaysAskPath(file);
      if (reasons.length) return { kind: "ask", reasons, key: `fixed:${reasons.join("; ")}` };
      const dir = path.dirname(path.resolve(cwd, expandHome(file)));
      return { kind: "judge", args: clip(JSON.stringify(input), 6_000), key: `${tool}:${dir}` };
    }
    if (BUILTIN_READ.has(tool)) {
      const file = String(input.path ?? "");
      if (tool === "read" && file && isCredentialPath(expandHome(file))) {
        return { kind: "ask", reasons: [`reads credentials (${file})`], key: `read:${file}` };
      }
      return { kind: "allow", why: "read-only tool" };
    }
    if (annotations(tool)?.readOnlyHint === true) return { kind: "allow", why: "read-only hint" };
    return { kind: "judge", args: clip(JSON.stringify(input), 6_000), key: `tool:${tool}` };
  };

  /** Ask the user, one dialog at a time. */
  const ask = (
    ctx: ExtensionContext,
    title: string,
    similarKey: string | undefined,
  ): Promise<{ block?: boolean; reason?: string } | undefined> => {
    const run = async () => {
      const options = ["Allow once", ...(similarKey ? ["Allow similar for this session"] : []), "Block"];
      const answer = await ctx.ui.select(title, options);
      if (answer === "Allow once") return undefined;
      if (answer === "Allow similar for this session" && similarKey) {
        allowSimilar.add(similarKey);
        return undefined;
      }
      return { block: true, reason: "The user declined this call. Do not retry it; continue without it, or ask the user how to proceed." };
    };
    const next = dialogs.then(run, run);
    dialogs = next.catch(() => undefined);
    return next;
  };

  /**
   * A held call: the first time in a user turn it is blocked with `reason` so the agent can work
   * around it; when the agent retries the same call (or another of the same family), it goes to the
   * user, or is blocked without one.
   */
  const hold = (
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
    family: string,
    reason: string,
    title: string,
    similarKey: string | undefined,
  ) => {
    const exact = `${tool}\0${JSON.stringify(input)}`;
    if (config.pushBack && !pushedBackThisTurn.has(exact) && !pushedBackThisTurn.has(family)) {
      pushedBackThisTurn.add(exact);
      pushedBackThisTurn.add(family);
      pushedBack++;
      status(ctx);
      return {
        block: true,
        reason:
          `${reason}\nThe user has not been asked. Get the job done another way if you can (a reversible, local, or narrower ` +
          "alternative). If there is no good alternative, say in one sentence why this call is needed, then make the identical " +
          "call again: tool-gate will ask the user to approve it.",
      };
    }
    held++;
    status(ctx);
    if (!ctx.hasUI) return { block: true, reason: `${reason}\nBlocked: there is no user to approve it.` };
    return ask(ctx, title, similarKey);
  };

  const describeCall = (tool: string, input: Record<string, unknown>) => {
    if (tool === "bash") return `bash: ${clip(String(input.command ?? ""), 200)}`;
    if (tool === "edit" || tool === "write") return `${tool}: ${String(input.path ?? "")}`;
    return `${tool}: ${clip(JSON.stringify(input), 200)}`;
  };

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig("tool-gate", DEFAULT_CONFIG, ctx.cwd);
    status(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    config = loadConfig("tool-gate", DEFAULT_CONFIG, ctx.cwd);
    pushedBackThisTurn.clear();
    gitInfo = undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!sessionOn || !config.enabled) return undefined;
    const tool = event.toolName;
    const input = event.input as Record<string, unknown>;
    const p = await plan(tool, input, ctx.cwd);

    if (p.kind === "allow") {
      auto++;
      status(ctx);
      return undefined;
    }

    if (p.kind === "ask") {
      const why = p.reasons.join("; ");
      return hold(ctx, tool, input, p.key, `tool-gate held this ${tool} call: it ${why}.`, `Allow? ${describeCall(tool, input)}\n${why}`, undefined);
    }

    if (allowSimilar.has(p.key)) {
      auto++;
      status(ctx);
      return undefined;
    }

    const rules = loadRules(ctx.cwd);
    const branch = ctx.sessionManager.getBranch();
    const texts = recentTexts(branch);
    const state = judgeState({
      userRequest: recentUserMessages(branch, 3).map((text, i, all) => clip(text, i === all.length - 1 ? 3_000 : 1_000)),
      recentIntent: clipTail(texts.assistant, 2_000),
      cwd: ctx.cwd,
      git: await git(ctx.cwd),
      tool,
      args: p.args,
      rules,
    });
    const outcome = await askJev(ctx.modelRegistry, config.jev, state, judgeQuestions(rules), ctx.signal);

    if (!outcome.ok) {
      if (!warnedUnavailable && ctx.hasUI && !/off in settings/u.test(outcome.reason)) {
        warnedUnavailable = true;
        ctx.ui.notify(`tool-gate: Jev unavailable (${outcome.reason}); asking for calls Pi's tool hints flag.`, "warning");
      }
      const hints = annotations(tool);
      const flagged =
        hints?.destructiveHint === true ||
        (!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));
      if (!flagged || !ctx.hasUI) {
        auto++;
        status(ctx);
        return undefined;
      }
      held++;
      status(ctx);
      return ask(ctx, `Allow? ${describeCall(tool, input)}\n(Jev unavailable: ${outcome.reason})`, p.key);
    }

    if (outcome.usage) pendingUsage.set(event.toolCallId, outcome.usage);
    const v = verdict(outcome.answers, rules, config.thresholds);
    const action = !v || v.allow ? "allow" : "hold";
    pi.appendEntry("tool-gate:decision", {
      tool,
      args: clip(p.args, 500),
      scores: v?.scores,
      failures: v?.failures,
      action,
      latencyMs: outcome.latencyMs,
      inputTokens: outcome.usage?.input,
    });

    if (action === "allow") {
      auto++;
      status(ctx);
      return undefined;
    }
    const rules_ = v!.brokenRules.length ? `\nRules: ${v!.brokenRules.map((r) => `"${clip(r, 120)}"`).join(", ")}` : "";
    return hold(ctx, tool, input, p.key, steerReason(tool, v!), `Allow? ${describeCall(tool, input)}\nJev: ${v!.failures.join("; ")}${rules_}`, p.key);
  });

  pi.on("tool_result", (event) => {
    const usage = pendingUsage.get(event.toolCallId);
    if (!usage) return undefined;
    pendingUsage.delete(event.toolCallId);
    return { usage: addUsage(event.usage as ClassifierUsage | undefined, usage) as never };
  });

  pi.registerCommand("gate", {
    description: "tool-gate: status, on, or off (this session)",
    getArgumentCompletions: (prefix: string) =>
      ["status", "on", "off"].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "on" || arg === "off") {
        sessionOn = arg === "on";
        status(ctx);
        ctx.ui.notify(`tool-gate ${arg} for this session`, "info");
        return;
      }
      const rules = loadRules(ctx.cwd);
      ctx.ui.notify(
        [
          `tool-gate ${sessionOn && config.enabled ? "on" : "off"}: ${auto} auto-approved, ${pushedBack} pushed back, ${held} asked this session.`,
          `Jev: ${config.jev.enabled ? `${config.jev.provider}/${config.jev.model}` : "off"}; push-back ${config.pushBack ? "on" : "off"}.`,
          `${rules.length} project rule${rules.length === 1 ? "" : "s"}; ${allowSimilar.size} "allow similar" grant${allowSimilar.size === 1 ? "" : "s"}.`,
        ].join("\n"),
        "info",
      );
    },
  });
}

export function addUsage(a: ClassifierUsage | undefined, b: ClassifierUsage): ClassifierUsage {
  if (!a) return b;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}
