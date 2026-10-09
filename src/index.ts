// pi-tool-gate: auto-approves tool calls. Fixed rules settle the clear cases (read-only calls run,
// a short list of dangerous ones is always held); Jev, through Pi's own classifier models, judges
// the gray zone. A held call is first blocked with Jev's explanation and suggested workaround; the
// agent works around it or makes its case and retries, and only that retry is put to you, with the
// case. Project rules in `.agents/tool-gate-rules.md` (or `.pi/`) are checked on every judged
// call. Without Jev the gate falls back to Pi's tool hints.
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { alwaysAskBash, alwaysAskPath, bashKeys, expandHome, isCredentialPath, isReadOnlyBash, secretGitAdds } from "./bash.ts";
import { loadConfig } from "./config.ts";
import { whileBlocked } from "./herdr.ts";
import { type ClassifierUsage, type JevConfig, askJev } from "./jev.ts";
import {
  DEFAULT_THRESHOLDS,
  type Thresholds,
  WORKAROUNDS,
  judgeQuestions,
  judgeState,
  steerReason,
  suggestions,
  verdict,
  workaroundQuestion,
} from "./judge.ts";
import { askApproval } from "./prompt.ts";
import { loadRules } from "./rules.ts";
import { agentBeforeLatestUser, callerText, clip, clipTail, recentTexts, recentUserMessages } from "./transcript.ts";
import { callView } from "./view.ts";

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
  | { kind: "ask"; reasons: string[]; key: string; args: string }
  | { kind: "judge"; args: string; key: string; similar: Similar };

/** What "allow similar for this session" grants: every key, described for the user. */
interface Similar {
  keys: string[];
  label: string;
}

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

  /** Which of these paths git ignores, asked in the directory each `git add` runs in. */
  const ignoredByGit = async (byDir: Map<string, string[]>): Promise<Set<string>> => {
    const ignored = new Set<string>();
    for (const [dir, files] of byDir) {
      try {
        const out = await pi.exec("git", ["-C", dir, "check-ignore", "--", ...files], { timeout: 2_000 });
        for (const line of out.stdout.split("\n")) if (line.trim()) ignored.add(path.resolve(dir, line.trim()));
      } catch {
        // Unknown means not ignored: the call is held.
      }
    }
    return ignored;
  };

  const plan = async (tool: string, input: Record<string, unknown>, cwd: string): Promise<Plan> => {
    if (config.allowTools.includes(tool)) return { kind: "allow", why: "allow list" };
    if (tool === "bash") {
      const command = String(input.command ?? "");
      const reasons = alwaysAskBash(command, cwd, (await git(cwd))?.branch, await ignoredByGit(secretGitAdds(command, cwd)));
      if (reasons.length) return { kind: "ask", reasons, key: `fixed:${reasons.join("; ")}`, args: clip(command, 6_000) };
      if (isReadOnlyBash(command, config.readOnlyCommands)) return { kind: "allow", why: "read-only command" };
      const keys = bashKeys(command, config.readOnlyCommands);
      return {
        kind: "judge",
        args: clip(command, 6_000),
        key: `bash:${keys.join("|")}`,
        similar: { keys: keys.map((k) => `bash:${k}`), label: keys.map((k) => `\`${k}\``).join(", ") },
      };
    }
    if (tool === "edit" || tool === "write") {
      const file = String(input.path ?? "");
      const reasons = alwaysAskPath(file);
      if (reasons.length) return { kind: "ask", reasons, key: `fixed:${reasons.join("; ")}`, args: clip(JSON.stringify(input), 6_000) };
      const dir = path.dirname(path.resolve(cwd, expandHome(file)));
      const shown = path.relative(cwd, dir) || ".";
      return {
        kind: "judge",
        args: clip(JSON.stringify(input), 6_000),
        key: `${tool}:${dir}`,
        similar: { keys: [`${tool}:${dir}`], label: `${tool}s in ${shown.startsWith("..") ? dir : shown}` },
      };
    }
    if (BUILTIN_READ.has(tool)) {
      const file = String(input.path ?? "");
      if (tool === "read" && file && isCredentialPath(expandHome(file))) {
        return { kind: "ask", reasons: [`reads credentials (${file})`], key: `read:${file}`, args: clip(JSON.stringify(input), 2_000) };
      }
      return { kind: "allow", why: "read-only tool" };
    }
    if (annotations(tool)?.readOnlyHint === true) return { kind: "allow", why: "read-only hint" };
    return { kind: "judge", args: clip(JSON.stringify(input), 6_000), key: `tool:${tool}`, similar: { keys: [`tool:${tool}`], label: `${tool} calls` } };
  };

  /** Ask the user, one dialog at a time. */
  const ask = (
    ctx: ExtensionContext,
    q: { tool: string; input: Record<string, unknown>; held?: string; agentCase?: string; note?: string },
    similar: Similar | undefined,
  ): Promise<{ block?: boolean; reason?: string } | undefined> => {
    const run = async () => {
      const similarOption = similar ? `Allow similar for this session (${clip(similar.label, 80)})` : undefined;
      const options = ["Allow once", ...(similarOption ? [similarOption] : []), "Block"];
      const title = [
        `Allow? ${describeCall(q.tool, q.input)}`,
        ...(q.held !== undefined ? [`Held: ${q.held}`] : []),
        ...(q.held !== undefined || q.agentCase !== undefined
          ? [`Agent: ${q.agentCase ? clip(q.agentCase.replace(/\s+/gu, " "), 600) : "(gave no reason)"}`]
          : []),
        ...(q.note ? [`(${q.note})`] : []),
      ].join("\n");
      const view = await callView(q.tool, q.input, ctx.cwd);
      // Held only while the dialog is open, so queued approvals do not report blocked early.
      const label = clip(`Allow? ${describeCall(q.tool, q.input)}`.replace(/\s+/gu, " "), 60);
      const answer = await whileBlocked(pi.events, label, () =>
        askApproval(ctx, { view, held: q.held, agentCase: q.agentCase, note: q.note, options }, title),
      );
      if (answer === "Allow once") return undefined;
      if (answer !== undefined && answer === similarOption && similar) {
        for (const key of similar.keys) allowSimilar.add(key);
        return undefined;
      }
      return { block: true, reason: "The user declined this call. Do not retry it; continue without it, or ask the user how to proceed." };
    };
    const next = dialogs.then(run, run);
    dialogs = next.catch(() => undefined);
    return next;
  };

  /** The state Jev judges a call in. */
  const judgeStateFor = async (ctx: ExtensionContext, tool: string, args: string, rules: readonly string[]) => {
    const branch = ctx.sessionManager.getBranch();
    return judgeState({
      userRequest: recentUserMessages(branch, 3).map((text, i, all) => clip(text, i === all.length - 1 ? 3_000 : 1_000)),
      agentBefore: clipTail(agentBeforeLatestUser(branch), 1_500),
      recentIntent: clipTail(recentTexts(branch).assistant, 2_000),
      cwd: ctx.cwd,
      git: await git(ctx.cwd),
      tool,
      args,
      rules,
    });
  };

  /**
   * A held call. The first time in a user turn it is blocked with Jev's explanation and suggested
   * workaround, and the agent either works around it or makes its case and retries the identical
   * call. That retry (or another held call of the same family) goes to the user with the agent's
   * case, or is blocked without a user.
   */
  const hold = async (
    ctx: ExtensionContext,
    h: {
      toolCallId: string;
      tool: string;
      input: Record<string, unknown>;
      family: string;
      /** Why it was held, for the agent. */
      reason: string;
      /** Why it was held, one line for the user. */
      summary: string;
      similar: Similar | undefined;
      state: Record<string, unknown>;
    },
  ) => {
    const exact = `${h.tool}\0${JSON.stringify(h.input)}`;
    if (config.pushBack && !pushedBackThisTurn.has(exact) && !pushedBackThisTurn.has(h.family)) {
      pushedBackThisTurn.add(exact);
      pushedBackThisTurn.add(h.family);
      pushedBack++;
      status(ctx);
      const suggestion = await askJev(ctx.modelRegistry, config.jev, { ...h.state, held_because: h.reason }, workaroundQuestion(), ctx.signal);
      const ideas = suggestion.ok ? suggestions(suggestion.answers) : [];
      if (suggestion.ok && suggestion.usage) pendingUsage.set(h.toolCallId, addUsage(pendingUsage.get(h.toolCallId), suggestion.usage));
      const noWorkaround = ideas[0] === WORKAROUNDS.user_only;
      const advice = noWorkaround
        ? "Jev sees no workaround: whether to do this is the user's decision."
        : ideas.length
          ? `Jev suggests: ${ideas.join("; or ")}.`
          : "Look for a safer way: reversible, local, narrower, or previewed first.";
      return {
        block: true,
        reason:
          `${h.reason}\n${advice}\nThe user has not been asked. ` +
          (noWorkaround ? "If the call still seems worth it, " : "Get the job done another way if you can. If no workaround is good enough, ") +
          "make your case: in a short visible message to the user (not only in your thinking), say why this exact call is needed" +
          (noWorkaround ? "" : " and why the workarounds fall short") +
          ", then make the identical call in that same message. tool-gate will show your case to the user and ask them to approve it. " +
          "If it is not worth raising, carry on without it.",
      };
    }
    held++;
    status(ctx);
    if (!ctx.hasUI) return { block: true, reason: `${h.reason}\nBlocked: there is no user to approve it.` };
    const agentCase = callerText(ctx.sessionManager.getBranch(), h.toolCallId);
    return ask(ctx, { tool: h.tool, input: h.input, held: h.summary, agentCase: clip(agentCase, 4_000) }, h.similar);
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
      return hold(ctx, {
        toolCallId: event.toolCallId,
        tool,
        input,
        family: p.key,
        reason: `tool-gate held this ${tool} call: it ${why}. Calls like this are always held, whatever Jev says.`,
        summary: why,
        similar: undefined,
        state: await judgeStateFor(ctx, tool, p.args, []),
      });
    }

    if (p.similar.keys.every((key) => allowSimilar.has(key))) {
      auto++;
      status(ctx);
      return undefined;
    }

    const rules = loadRules(ctx.cwd);
    const state = await judgeStateFor(ctx, tool, p.args, rules);
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
      return ask(ctx, { tool, input, note: `Jev unavailable: ${outcome.reason}` }, p.similar);
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
    const rules_ = v!.brokenRules.length ? ` (${v!.brokenRules.map((r) => `"${clip(r, 120)}"`).join(", ")})` : "";
    return hold(ctx, {
      toolCallId: event.toolCallId,
      tool,
      input,
      family: p.key,
      reason: steerReason(tool, v!),
      summary: `${v!.failures.join("; ")}${rules_}`,
      similar: p.similar,
      state,
    });
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
