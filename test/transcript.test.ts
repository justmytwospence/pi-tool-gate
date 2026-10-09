import { expect, test } from "vitest";
import { callerText } from "../src/transcript.ts";

const entry = (content: unknown[]) => ({ type: "message", message: { role: "assistant", content } });
const call = { type: "toolCall", id: "t1", name: "bash", arguments: {} };

test("callerText prefers the visible text beside the call", () => {
  const branch = [entry([{ type: "thinking", thinking: "private" }, { type: "text", text: "Pushing is what you asked for." }, call])];
  expect(callerText(branch, "t1")).toBe("Pushing is what you asked for.");
});

test("callerText falls back to thinking when the agent wrote no text", () => {
  const branch = [
    entry([
      { type: "thinking", thinking: "", redacted: true },
      { type: "thinking", thinking: "Pushing this branch and opening the PR, as you chose.\n\n" },
      call,
    ]),
  ];
  expect(callerText(branch, "t1")).toBe("Pushing this branch and opening the PR, as you chose.");
});

test("callerText is empty when the call came with neither", () => {
  expect(callerText([entry([call])], "t1")).toBe("");
  expect(callerText([entry([{ type: "text", text: "other" }])], "t1")).toBe("");
});
