// The approval dialog. In Pi's terminal UI a held call is shown laid out and highlighted (bash one
// step per line, edits as diffs), with why it was held and the agent's case rendered as Markdown;
// long parts are clamped and ctrl+o expands them. Elsewhere (RPC clients, forwarded subagent
// dialogs) it falls back to a plain select with a one-line summary.
import {
  DynamicBorder,
  type ExtensionContext,
  getMarkdownTheme,
  getSelectListTheme,
  highlightCode,
  type KeybindingsManager,
  keyHint,
  rawKeyHint,
  renderDiff,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Markdown, SelectList, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { CallView } from "./view.ts";

export interface Approval {
  view: CallView;
  /** Why the call was held, one line. */
  held?: string;
  /** The agent's case for the call, in its own words (Markdown). */
  agentCase?: string;
  /** Anything else the user should know, e.g. that Jev was unavailable. */
  note?: string;
  /** Choices, the last of which is the refusal Esc picks. */
  options: string[];
}

/** Ask the user to approve a call; resolves to the chosen option, or undefined if dismissed. */
export async function askApproval(ctx: ExtensionContext, approval: Approval, fallbackTitle: string): Promise<string | undefined> {
  if (ctx.mode === "tui") {
    try {
      const choice = await ctx.ui.custom<string | undefined>(
        (tui, theme, keybindings, done) => new ApprovalDialog(tui, theme, keybindings, approval, done),
      );
      if (choice !== undefined) return choice;
    } catch {
      // Fall through to the plain dialog rather than lose the question.
    }
  }
  return ctx.ui.select(fallbackTitle, approval.options);
}

/** Shows the first `limit()` lines of a child, then a hint to expand. */
class Clamp implements Component {
  private readonly child: Component;
  private readonly limit: () => number | undefined;
  private readonly hint: (hidden: number) => string;
  /** Whether the last render, or any before it, left lines out. */
  clamped = false;
  constructor(child: Component, limit: () => number | undefined, hint: (hidden: number) => string) {
    this.child = child;
    this.limit = limit;
    this.hint = hint;
  }
  render(width: number): string[] {
    const lines = this.child.render(width);
    const n = this.limit();
    if (n === undefined || lines.length <= n + 1) return lines;
    this.clamped = true;
    return [...lines.slice(0, n), this.hint(lines.length - n)];
  }
  invalidate(): void {
    this.child.invalidate();
  }
}

class ApprovalDialog implements Component {
  private expanded = false;
  private readonly root = new Container();
  /** Key hints and the closing border; painted after the body so they know whether it was clamped. */
  private readonly footer = new Container();
  private readonly list: SelectList;
  private readonly title = new Text("", 1, 0);
  private readonly body = new Text("", 0, 0);
  private readonly held = new Text("", 1, 0);
  private readonly caseLabel = new Text("", 1, 0);
  private readonly caseText: Component;
  private readonly note = new Text("", 1, 0);
  private readonly hints = new Text("", 1, 0);
  private readonly clamps: Clamp[] = [];

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly a: Approval;

  constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, a: Approval, done: (choice: string | undefined) => void) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.a = a;
    const refuse = a.options[a.options.length - 1];
    this.list = new SelectList(
      a.options.map((o) => ({ value: o, label: o })),
      a.options.length,
      getSelectListTheme(),
    );
    this.list.onSelect = (item) => done(item.value);
    this.list.onCancel = () => done(refuse);

    const rows = () => (this.expanded ? undefined : Math.max(8, Math.floor(tui.terminal.rows * 0.4)));
    const more = (hidden: number) =>
      `${theme.fg("muted", `... ${hidden} more line${hidden === 1 ? "" : "s"}, `)}${keyHint("app.tools.expand", "to expand")}`;
    this.caseText = a.agentCase ? new Markdown(a.agentCase, 1, 0, getMarkdownTheme()) : new Text("", 1, 0);

    const border = () => new DynamicBorder((s) => theme.fg("warning", s));
    const clamp = (child: Component, limit: () => number | undefined) => {
      const c = new Clamp(child, limit, more);
      this.clamps.push(c);
      return c;
    };
    const box = new Box(1, 1, (s) => theme.bg("toolPendingBg", s));
    box.addChild(clamp(this.body, rows));
    this.root.addChild(border());
    this.root.addChild(new Spacer(1));
    this.root.addChild(this.title);
    this.root.addChild(new Spacer(1));
    this.root.addChild(box);
    if (a.held) {
      this.root.addChild(new Spacer(1));
      this.root.addChild(this.held);
    }
    if (a.held !== undefined || a.agentCase !== undefined) {
      this.root.addChild(new Spacer(1));
      this.root.addChild(this.caseLabel);
      if (a.agentCase) this.root.addChild(clamp(this.caseText, () => (this.expanded ? undefined : 12)));
    }
    if (a.note) {
      this.root.addChild(new Spacer(1));
      this.root.addChild(this.note);
    }
    this.root.addChild(new Spacer(1));
    const options = new Box(1, 0);
    options.addChild(this.list);
    this.root.addChild(options);
    this.root.addChild(new Spacer(1));
    this.footer.addChild(this.hints);
    this.footer.addChild(border());
    this.paint();
  }

  /** Bake the theme's colours into the text; again on every theme change. */
  private paint(): void {
    const { theme, a } = this;
    const v = a.view;
    this.title.setText(
      [
        theme.fg("warning", theme.bold("Allow?")),
        theme.fg("toolTitle", theme.bold(v.tool)),
        v.subject ? theme.fg("accent", v.subject) : "",
        v.note ? theme.fg("muted", `(${v.note})`) : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    const body =
      v.body.kind === "diff"
        ? renderDiff(v.body.text)
        : v.body.text
          ? highlightCode(v.body.text, v.body.lang).join("\n")
          : theme.fg("muted", "(empty)");
    this.body.setText(body);
    this.held.setText(`${theme.fg("warning", theme.bold("Held: "))}${theme.fg("text", a.held ?? "")}`);
    this.caseLabel.setText(
      theme.fg("accent", theme.bold("Agent:")) + (a.agentCase ? "" : ` ${theme.fg("muted", theme.italic("(gave no reason)"))}`),
    );
    this.note.setText(theme.fg("muted", a.note ?? ""));
    this.paintHints();
  }

  private paintHints(): void {
    const expandable = this.clamps.some((c) => c.clamped);
    this.hints.setText(
      [
        rawKeyHint("↑↓", "navigate"),
        keyHint("tui.select.confirm", "select"),
        keyHint("tui.select.cancel", "block"),
        ...(expandable ? [keyHint("app.tools.expand", this.expanded ? "collapse" : "expand")] : []),
      ].join("  "),
    );
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.tools.expand")) {
      this.expanded = !this.expanded;
      this.invalidate();
    } else if (data === "j" || data === "k") {
      this.list.handleInput(data === "j" ? "\x1b[B" : "\x1b[A");
    } else {
      this.list.handleInput(data);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const body = this.root.render(width);
    this.paintHints();
    return [...body, ...this.footer.render(width)];
  }

  invalidate(): void {
    this.paint();
    this.root.invalidate();
    this.footer.invalidate();
  }
}
