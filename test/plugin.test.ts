import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import TastyAdapter from "../src/adapters/opencode.js";
import TastyPlugin from "../src/plugin.js";

const NINE_TOOLS = [
  "tasty_start",
  "tasty_present",
  "tasty_choose",
  "tasty_revise_plan",
  "tasty_status",
  "tasty_resume",
  "tasty_complete",
  "tasty_compile",
  "tasty_apply",
];

describe("OpenCode plugin vertical smoke", () => {
  it("re-exports the adapter unchanged from the compatibility path", async () => {
    expect(TastyPlugin).toBe(TastyAdapter);
    expect(Object.keys((await TastyAdapter({} as never)).tool!).sort()).toEqual([...NINE_TOOLS].sort());
  });

  it("registers the complete decision flow and applies its compiled profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tasty-plugin-"));
    const hooks = await TastyPlugin({} as never);
    const tools = hooks.tool!;
    const context = {
      directory: root,
      worktree: root,
      sessionID: "opencode-session",
      messageID: "message",
      agent: "build",
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    };

    expect(Object.keys(tools)).toEqual(expect.arrayContaining(NINE_TOOLS));

    const started = JSON.parse(
      (await tools.tasty_start!.execute(
        {
          target: "README direction",
          estimatedRounds: 1,
          plan: [{ id: "direction", purpose: "Choose direction", scale: "macro" }],
        },
        context,
      )) as string,
    ) as { sessionId: string };

    const presented = JSON.parse(
      (await tools.tasty_present!.execute(
        {
          sessionId: started.sessionId,
          planItemId: "direction",
          candidates: [
            { label: "A", text: "Action first" },
            { label: "B", text: "Concept first" },
          ],
        },
        context,
      )) as string,
    ) as { comparison: { id: string } };

    await tools.tasty_choose!.execute({ sessionId: started.sessionId, choice: "A", reason: "Immediate utility" }, context);
    await tools.tasty_complete!.execute({ sessionId: started.sessionId }, context);
    await tools.tasty_compile!.execute(
      {
        sessionId: started.sessionId,
        synthesis: {
          summary: "Lead with action.",
          confirmedRules: [
            { rule: "Lead with the first executable action.", evidenceComparisonIds: [presented.comparison.id] },
          ],
          antiRules: [],
          contextualRules: [],
          unresolved: [],
          decisionBoundaries: ["Keep required context."],
        },
      },
      context,
    );

    const applied = JSON.parse(
      (await tools.tasty_apply!.execute({ sessionId: started.sessionId }, context)) as string,
    ) as { version: number; markdown: string };

    expect(applied.version).toBe(1);
    expect(applied.markdown).toContain("Lead with the first executable action.");
    expect(applied.markdown).toContain("Keep required context.");
  });
});
