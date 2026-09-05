import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const EXACT_TARGET = "  우리 팀의 README 방향을 정하고 싶어요 ✨  ";

class Capture {
  out = "";
  err = "";
  constructor(readonly cwd: string) {}
  get streams() {
    return {
      cwd: this.cwd,
      stdout: (chunk: string) => {
        this.out += chunk;
      },
      stderr: (chunk: string) => {
        this.err += chunk;
      },
    };
  }
  json<T>(): T {
    return JSON.parse(this.out) as T;
  }
}

let root: string;
let io: Capture;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "tasty-cli-"));
  io = new Capture(root);
});

async function run(...argv: string[]): Promise<number> {
  io.out = "";
  io.err = "";
  return runCli(argv, io.streams);
}

const startInput = {
  target: EXACT_TARGET,
  estimatedRounds: 1,
  plan: [{ id: "direction", purpose: "Choose the overall direction", scale: "macro" }],
  references: [{ id: "cieran", title: "Cieran", role: "inspiration" }],
};

const candidates = [
  { label: "A", text: "Task-first guide", referenceIds: ["cieran"] },
  { label: "B", text: "Concept-first reference" },
];

async function startSession(): Promise<string> {
  const code = await run("start", "--input", JSON.stringify(startInput));
  expect(code).toBe(0);
  return io.json<{ sessionId: string }>().sessionId;
}

describe("standalone CLI", () => {
  it("starts a session from JSON input and preserves the exact target text", async () => {
    const code = await run("start", "--input", JSON.stringify(startInput));

    expect(code).toBe(0);
    expect(io.err).toBe("");
    const result = io.json<{ sessionId: string; target: string; estimatedRounds: number }>();
    expect(result.target).toBe(EXACT_TARGET);
    expect(result.estimatedRounds).toBe(1);
    expect(result.sessionId).toMatch(/^tasty_/);
    expect(io.out.endsWith("\n")).toBe(true);
  });

  it("reads structured input from an @file argument", async () => {
    const inputPath = path.join(root, "start.json");
    await writeFile(inputPath, JSON.stringify(startInput), "utf8");

    expect(await run("start", "--input", `@${inputPath}`)).toBe(0);
    expect(io.json<{ target: string }>().target).toBe(EXACT_TARGET);
  });

  it("resolves @file paths relative to the invocation directory", async () => {
    await writeFile(path.join(root, "start.json"), JSON.stringify(startInput), "utf8");

    expect(await run("start", "--input", "@start.json")).toBe(0);
    expect(io.json<{ target: string }>().target).toBe(EXACT_TARGET);
  });

  it("writes the session under --root rather than the invocation directory", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tasty-workspace-"));

    expect(await run("--root", workspace, "start", "--input", JSON.stringify(startInput))).toBe(0);
    const sessionId = io.json<{ sessionId: string }>().sessionId;

    expect(await run("--root", workspace, "status", sessionId)).toBe(0);
    expect(await run("status", sessionId)).not.toBe(0);
  });

  it("runs the complete lifecycle and reports progress at each step", async () => {
    const sessionId = await startSession();

    expect(await run("present", sessionId, "--input", JSON.stringify({ planItemId: "direction", candidates }))).toBe(0);
    const presented = io.json<{ comparison: { id: string; purpose: string }; progress: { display: string } }>();
    expect(presented.comparison.purpose).toBe("Choose the overall direction");
    expect(presented.progress.display).toBe("(1/1 예정)");

    expect(await run("choose", sessionId, "--choice", "A", "--reason", "Readers arrive with a task")).toBe(0);
    expect(io.json<{ decision: { choice: string; reason: string } }>().decision).toMatchObject({
      choice: "A",
      reason: "Readers arrive with a task",
    });

    expect(await run("status", sessionId)).toBe(0);
    expect(io.json<{ session: { id: string }; progress: { completed: number } }>()).toMatchObject({
      session: { id: sessionId, target: EXACT_TARGET },
      progress: { completed: 1 },
    });

    expect(await run("resume", sessionId)).toBe(0);
    expect(io.json<{ session: { id: string; status: string } }>().session).toMatchObject({
      id: sessionId,
      status: "active",
    });

    expect(await run("complete", sessionId)).toBe(0);
    expect(io.json<{ status: string }>().status).toBe("complete");

    expect(await run("compile", sessionId)).toBe(0);
    const compiled = io.json<{ version: number; directory: string; files: string[] }>();
    expect(compiled.version).toBe(1);
    expect(compiled.files).toHaveLength(3);

    expect(await run("apply", sessionId)).toBe(0);
    const applied = io.json<{ version: number; markdown: string }>();
    expect(applied.version).toBe(1);
    expect(applied.markdown).toContain("Task-first guide");

    expect(await run("apply", sessionId, "--version", "1")).toBe(0);
    expect(io.json<{ version: number }>().version).toBe(1);
  });

  it("revises the plan and explains the new estimate", async () => {
    const sessionId = await startSession();
    const revision = {
      estimatedRounds: 2,
      reason: "Examples need their own decision",
      plan: [
        ...startInput.plan,
        { id: "examples", purpose: "Choose example density", scale: "detail" },
      ],
    };

    expect(await run("revise-plan", sessionId, "--input", JSON.stringify(revision))).toBe(0);
    expect(io.json<{ estimatedRounds: number; progress: { explanation: string } }>()).toMatchObject({
      estimatedRounds: 2,
      progress: { explanation: "예상 질문 수가 1개에서 2개로 변경되었습니다: Examples need their own decision" },
    });
  });

  it("compiles an explicitly supplied synthesis", async () => {
    const sessionId = await startSession();
    await run("present", sessionId, "--input", JSON.stringify({ planItemId: "direction", candidates }));
    const comparisonId = io.json<{ comparison: { id: string } }>().comparison.id;
    await run("choose", sessionId, "--choice", "A");
    await run("complete", sessionId);

    const synthesis = {
      summary: "Lead with the task.",
      confirmedRules: [{ rule: "Lead with the first executable action.", evidenceComparisonIds: [comparisonId] }],
      antiRules: [],
      contextualRules: [
        { context: "Tutorials", rule: "Show a runnable snippet first.", evidenceComparisonIds: [comparisonId] },
      ],
      unresolved: ["Whether to keep a glossary"],
      decisionBoundaries: ["Keep required context."],
    };
    expect(await run("compile", sessionId, "--input", JSON.stringify(synthesis))).toBe(0);
    expect(await run("apply", sessionId)).toBe(0);
    const markdown = io.json<{ markdown: string }>().markdown;
    expect(markdown).toContain("Lead with the first executable action.");
    expect(markdown).toContain("**Tutorials:** Show a runnable snippet first.");
    expect(markdown).toContain("Whether to keep a glossary");
  });

  it("records hybrid choices with the resolution text the user supplied", async () => {
    const sessionId = await startSession();
    await run("present", sessionId, "--input", JSON.stringify({ planItemId: "direction", candidates }));

    expect(await run("choose", sessionId, "--choice", "M", "--resolution", "Concise, with friendly examples")).toBe(0);
    expect(io.json<{ decision: { choice: string; resolution: string } }>().decision).toMatchObject({
      choice: "M",
      resolution: "Concise, with friendly examples",
    });
  });

  it("accepts structured choose input as JSON as well as flags", async () => {
    const sessionId = await startSession();
    await run("present", sessionId, "--input", JSON.stringify({ planItemId: "direction", candidates }));

    expect(await run("choose", sessionId, "--input", JSON.stringify({ choice: "D", resolution: "Use my house style" }))).toBe(0);
    expect(io.json<{ decision: { choice: string } }>().decision.choice).toBe("D");
  });

  it("prints usage listing every lifecycle command", async () => {
    expect(await run("--help")).toBe(0);
    for (const command of [
      "start",
      "present",
      "choose",
      "revise-plan",
      "status",
      "resume",
      "complete",
      "compile",
      "apply",
    ]) {
      expect(io.out).toContain(command);
    }
    expect(io.out).toContain("--root");
    expect(io.err).toBe("");
  });

  it("prints usage to stderr and exits 2 when no command is given", async () => {
    expect(await run()).toBe(2);
    expect(io.err).toContain("start");
    expect(io.out).toBe("");
  });

  it("rejects an unknown command with a usage exit code", async () => {
    expect(await run("frobnicate", "x")).toBe(2);
    expect(io.err).toContain("frobnicate");
    expect(io.out).toBe("");
  });

  it("rejects an unknown flag for a command", async () => {
    expect(await run("status", "tasty_1", "--choice", "A")).toBe(2);
    expect(io.err).toContain("--choice");
  });

  it("rejects a repeated option instead of silently keeping the last value", async () => {
    const sessionId = await startSession();
    await run("present", sessionId, "--input", JSON.stringify({ planItemId: "direction", candidates }));

    expect(await run("choose", sessionId, "--choice", "A", "--choice", "B")).toBe(2);
    expect(io.err).toContain("--choice");
    expect(io.err).toContain("once");
    expect(io.out).toBe("");

    // The rejected invocation must not have recorded anything.
    expect(await run("status", sessionId)).toBe(0);
    expect(io.json<{ progress: { completed: number } }>().progress.completed).toBe(0);
  });

  it("rejects a repeated option written with = and with a separate value", async () => {
    expect(await run("start", "--input=1", "--input", "2")).toBe(2);
    expect(io.err).toContain("--input");
    expect(io.err).toContain("once");
  });

  it("rejects a repeated --root", async () => {
    expect(await run("--root", ".", "--root", "..", "status", "tasty_1")).toBe(2);
    expect(io.err).toContain("--root");
    expect(io.err).toContain("once");
  });

  it("rejects mixing --input with the choose flags", async () => {
    const sessionId = await startSession();
    await run("present", sessionId, "--input", JSON.stringify({ planItemId: "direction", candidates }));

    for (const flag of [
      ["--choice", "B"],
      ["--reason", "because"],
      ["--resolution", "a blend"],
    ]) {
      expect(await run("choose", sessionId, "--input", JSON.stringify({ choice: "A" }), ...flag)).toBe(2);
      expect(io.err).toContain("--input");
      expect(io.err).toContain(flag[0]!);
      expect(io.out).toBe("");
    }

    expect(await run("status", sessionId)).toBe(0);
    expect(io.json<{ progress: { completed: number } }>().progress.completed).toBe(0);
  });

  it("still accepts --input alone and the flag form alone for choose", async () => {
    const sessionId = await startSession();
    await run("present", sessionId, "--input", JSON.stringify({ planItemId: "direction", candidates }));

    expect(await run("choose", sessionId, "--input", JSON.stringify({ choice: "M", resolution: "Blend" }))).toBe(0);
    expect(io.json<{ decision: { choice: string } }>().decision.choice).toBe("M");
  });

  it("rejects a missing session id", async () => {
    expect(await run("status")).toBe(2);
    expect(io.err).toContain("session-id");
  });

  it("rejects extra positional arguments", async () => {
    expect(await run("status", "tasty_1", "extra")).toBe(2);
    expect(io.err).toContain("extra");
  });

  it("reports malformed JSON input with a useful message", async () => {
    expect(await run("start", "--input", "{not json")).toBe(2);
    expect(io.err).toMatch(/--input/);
    expect(io.out).toBe("");
  });

  it("reports a missing @file input", async () => {
    expect(await run("start", "--input", "@missing.json")).toBe(2);
    expect(io.err).toContain("missing.json");
  });

  it("rejects structured input that does not match the command shape", async () => {
    expect(await run("start", "--input", JSON.stringify({ target: "x", estimatedRounds: "one", plan: [] }))).toBe(2);
    expect(io.err).toContain("estimatedRounds");

    expect(await run("start", "--input", JSON.stringify({ ...startInput, plan: "direction" }))).toBe(2);
    expect(io.err).toContain("plan");
  });

  it("requires exactly two candidates for present", async () => {
    const sessionId = await startSession();

    expect(await run("present", sessionId, "--input", JSON.stringify({ planItemId: "direction", candidates: [candidates[0]] }))).toBe(2);
    expect(io.err).toContain("candidates");
  });

  it("rejects an invalid choice value", async () => {
    const sessionId = await startSession();

    expect(await run("choose", sessionId, "--choice", "Z")).toBe(2);
    expect(io.err).toContain("choice");
  });

  it("surfaces domain rule violations as non-zero failures with stderr text", async () => {
    const sessionId = await startSession();
    await run("present", sessionId, "--input", JSON.stringify({ planItemId: "direction", candidates }));

    expect(await run("choose", sessionId, "--choice", "M")).toBe(1);
    expect(io.err).toContain("M requires resolution text");
    expect(io.out).toBe("");
  });

  it("surfaces an unknown session as a non-zero failure", async () => {
    expect(await run("status", "tasty_missing")).toBe(1);
    expect(io.err).not.toBe("");
    expect(io.out).toBe("");
  });

  it("rejects a session id that could escape the sessions directory", async () => {
    expect(await run("status", "../../etc")).toBe(1);
    expect(io.err).toContain("invalid session id");
  });

  it("refuses to compile a session that is not complete", async () => {
    const sessionId = await startSession();

    expect(await run("compile", sessionId)).toBe(1);
    expect(io.err).toContain("session must be complete before compiling");
  });

  it("points at the offending synthesis entry by index", async () => {
    const sessionId = await startSession();
    const synthesis = {
      summary: "Lead with the task.",
      confirmedRules: [],
      antiRules: [],
      contextualRules: [
        { rule: "Show a runnable snippet.", context: "Tutorials", evidenceComparisonIds: ["cmp_1"] },
        { context: "Reference pages", evidenceComparisonIds: ["cmp_1"] },
      ],
      unresolved: [],
      decisionBoundaries: [],
    };

    expect(await run("compile", sessionId, "--input", JSON.stringify(synthesis))).toBe(2);
    expect(io.err).toContain("synthesis.contextualRules[1].rule");
  });

  it("rejects a non-numeric --version for apply", async () => {
    const sessionId = await startSession();

    expect(await run("apply", sessionId, "--version", "latest")).toBe(2);
    expect(io.err).toContain("version");
  });
});
