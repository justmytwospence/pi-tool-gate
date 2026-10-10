// What a held call looks like to the user: the call laid out for reading (bash split one step per
// line, edits and overwrites as diffs, new files and other tools as highlightable code). Pure apart
// from reading the target file; colouring happens in the dialog.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { generateDiffString, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./bash.ts";

export type CallBody =
  | { kind: "code"; lang: string | undefined; text: string }
  /** Pi's diff format (`+12 line`, `-12 line`, ` 12 line`), as the edit tool renders it. */
  | { kind: "diff"; text: string };

export interface CallView {
  tool: string;
  /** The file for edit/write, else empty. */
  subject: string;
  /** A short remark on the body, e.g. "new file, 40 lines". */
  note?: string;
  body: CallBody;
}

/** Most lines worth laying out; the dialog shows fewer until expanded. */
const MAX_LINES = 2_000;
const MAX_FILE_BYTES = 2_000_000;

export async function callView(tool: string, input: Record<string, unknown>, cwd: string): Promise<CallView> {
  if (tool === "bash" || tool === "bg_run") return { tool, subject: tool === "bash" ? "" : String(input.name ?? ""), body: { kind: "code", lang: "bash", text: formatBash(String(input.command ?? "")) } };
  if (tool === "edit" || tool === "write") {
    const file = String(input.path ?? "");
    const abs = path.resolve(cwd, expandHome(file));
    const existing = await readSmall(abs);
    if (tool === "write") {
      const content = String(input.content ?? "");
      if (existing === undefined) {
        return { tool, subject: file, note: `new file, ${lineCount(content)} lines`, body: { kind: "code", lang: getLanguageFromPath(file), text: clipLines(content) } };
      }
      return { tool, subject: file, note: "overwrites", body: { kind: "diff", text: diff(existing, content) } };
    }
    const edits = editsOf(input);
    const note = edits.length === 1 ? undefined : `${edits.length} edits`;
    const applied = existing === undefined ? undefined : applyEdits(existing, edits);
    if (existing !== undefined && applied !== undefined) return { tool, subject: file, note, body: { kind: "diff", text: diff(existing, applied) } };
    // The edit will not apply as given (or the file is unreadable): show the edit text alone.
    const text = edits.map((e) => diff(e.oldText, e.newText)).join("\n     ...\n");
    return { tool, subject: file, note: `${note ? `${note}, ` : ""}no exact match in the file`, body: { kind: "diff", text } };
  }
  return { tool, subject: "", body: { kind: "code", lang: "json", text: clipLines(JSON.stringify(input, null, 2) ?? "{}") } };
}

/**
 * Lay a one-line command out one step per line, breaking after top-level `&&`, `||`, `|` and `;`.
 * Only whitespace changes; scripts that already span lines, heredocs and case arms are left alone.
 */
export function formatBash(command: string): string {
  const cmd = command.trim();
  if (cmd.length <= 80 || cmd.includes("\n") || /<<|;;/u.test(cmd)) return cmd;
  const steps: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string;
    if (quote) {
      if (c === "\\" && quote !== "'") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/u.test(cmd[i - 1] as string))) break;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (depth) continue;
    let op: string | undefined;
    if (cmd.startsWith("&&", i) || cmd.startsWith("||", i)) op = cmd.slice(i, i + 2);
    else if (c === "|" && cmd[i - 1] !== ">") op = cmd[i + 1] === "&" ? "|&" : "|";
    else if (c === ";") op = ";";
    if (!op) continue;
    const step = cmd.slice(start, i).trim();
    if (step) steps.push(op === ";" ? `${step};` : `${step} ${op}`);
    i += op.length - 1;
    start = i + 1;
  }
  const rest = cmd.slice(start).trim();
  if (rest) steps.push(rest);
  return steps.length < 2 ? cmd : steps.join("\n  ");
}

function editsOf(input: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
  const list = Array.isArray(input.edits) ? input.edits : [input];
  return list
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({ oldText: String(e.oldText ?? ""), newText: String(e.newText ?? "") }))
    .filter((e) => e.oldText || e.newText);
}

/** Each oldText replaced at its unique match in the original, or undefined if any is missing or ambiguous. */
function applyEdits(content: string, edits: Array<{ oldText: string; newText: string }>): string | undefined {
  const at: Array<{ index: number; oldText: string; newText: string }> = [];
  for (const e of edits) {
    if (!e.oldText) return undefined;
    const index = content.indexOf(e.oldText);
    if (index < 0 || content.indexOf(e.oldText, index + 1) >= 0) return undefined;
    at.push({ index, ...e });
  }
  at.sort((a, b) => a.index - b.index);
  for (let i = 1; i < at.length; i++) {
    const prev = at[i - 1]!;
    if (at[i]!.index < prev.index + prev.oldText.length) return undefined;
  }
  let out = content;
  for (const e of at.reverse()) out = out.slice(0, e.index) + e.newText + out.slice(e.index + e.oldText.length);
  return out;
}

function diff(before: string, after: string): string {
  return clipLines(generateDiffString(before, after, 3).diff);
}

async function readSmall(file: string): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > MAX_FILE_BYTES) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function lineCount(text: string): number {
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}

function clipLines(text: string): string {
  const lines = text.split("\n");
  return lines.length <= MAX_LINES ? text : [...lines.slice(0, MAX_LINES), `... ${lines.length - MAX_LINES} more lines`].join("\n");
}
