/** Text of a message's content (string or blocks), without thinking or tool calls. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? [String((block as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("\n");
}

interface EntryLike {
  type?: string;
  message?: { role?: string; content?: unknown };
}

/** The latest user message and the latest assistant text on the branch. */
export function recentTexts(entries: readonly unknown[]): { user: string; assistant: string } {
  let user = "";
  let assistant = "";
  for (let i = entries.length - 1; i >= 0 && (!user || !assistant); i--) {
    const entry = entries[i] as EntryLike;
    if (entry?.type !== "message" || !entry.message) continue;
    const text = messageText(entry.message.content).trim();
    if (!text) continue;
    if (!user && entry.message.role === "user") user = text;
    if (!assistant && !user && entry.message.role === "assistant") assistant = text;
  }
  return { user, assistant };
}

/**
 * The agent's last message before the newest user message: what a short reply like "yes" or
 * "do it" answers.
 */
export function agentBeforeLatestUser(entries: readonly unknown[]): string {
  let seenUser = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as EntryLike;
    if (entry?.type !== "message" || !entry.message) continue;
    const text = messageText(entry.message.content).trim();
    if (!text) continue;
    if (entry.message.role === "user") {
      if (seenUser) return "";
      seenUser = true;
    } else if (seenUser && entry.message.role === "assistant") return text;
  }
  return "";
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function clipTail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

/** The last `count` user messages on the branch, oldest first. */
export function recentUserMessages(entries: readonly unknown[], count: number): string[] {
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < count; i--) {
    const entry = entries[i] as EntryLike;
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = messageText(entry.message.content).trim();
    if (text) out.unshift(text);
  }
  return out;
}

/** Text of the assistant message that issued tool call `toolCallId` (the agent's words beside it). */
export function callerText(entries: readonly unknown[], toolCallId: string): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as EntryLike;
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    const issued =
      Array.isArray(content) &&
      content.some((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "toolCall" && (b as { id?: unknown }).id === toolCallId);
    if (issued) return messageText(content).trim();
  }
  return "";
}
