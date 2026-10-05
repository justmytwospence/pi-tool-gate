// Replays recorded tool-gate decisions (from session files) through live Jev with the current
// questions and thresholds: GATE_REPLAY=/path/to/decisions.json npm run eval -- eval/replay.eval.ts
// Each record: { user, intent, tool, args, label?: "allow" | "hold" | "either" }.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/index.ts";
import { askJev } from "../src/jev.ts";
import { judgeQuestions, judgeState, verdict } from "../src/judge.ts";
import { hasCredentials, installedRegistry } from "./registry.ts";

interface Recorded {
  user: string;
  intent: string;
  tool: string;
  args: string;
  label?: "allow" | "hold" | "either";
}

const file = process.env.GATE_REPLAY;
const records: Recorded[] = file ? JSON.parse(readFileSync(file, "utf8")) : [];

describe.skipIf(!hasCredentials || records.length === 0)("tool-gate replay", () => {
  let registry: unknown;
  const tally = { allow: 0, hold: 0, wrong: 0 };
  beforeAll(async () => {
    registry = await installedRegistry();
  });

  test("replay", async () => {
    for (const r of records) {
      const state = judgeState({ userRequest: r.user, recentIntent: r.intent, cwd: "~", tool: r.tool, args: r.args, rules: [] });
      const outcome = await askJev(registry, { ...DEFAULT_CONFIG.jev, timeoutMs: 15_000 }, state, judgeQuestions([]));
      if (!outcome.ok) continue;
      const v = verdict(outcome.answers, [], DEFAULT_CONFIG.thresholds);
      const got = v?.allow ? "allow" : "hold";
      tally[got]++;
      const label = r.label ?? "allow";
      if (label !== "either" && label !== got) tally.wrong++;
      console.log(`${label === "either" || label === got ? "ok  " : "MISS"} ${got.padEnd(5)} ${r.args.replace(/\s+/gu, " ").slice(0, 90)}  ${v?.failures.join("; ")}  ${JSON.stringify(v?.scores)}`);
    }
    console.log(`replay: ${tally.allow} allowed, ${tally.hold} held, ${tally.wrong} wrong of ${records.length}`);
    expect(tally.wrong).toBeLessThanOrEqual(Math.ceil(records.length * 0.05));
  }, 600_000);
});
