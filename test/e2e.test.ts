import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { progress, recordChoice } from "../src/core.js";
import { TastyService } from "../src/service.js";
import type { Clock, IdSource, PlanItem } from "../src/types.js";

class FixedClock implements Clock {
  private tick = 0;
  now(): string {
    return `2026-09-04T00:00:${String(this.tick++).padStart(2, "0")}.000Z`;
  }
}

class FixedIds implements IdSource {
  private tick = 0;
  next(prefix: string): string {
    return `${prefix}_${++this.tick}`;
  }
}

const initialPlan: PlanItem[] = [
  { id: "direction", purpose: "Choose the overall documentation direction", scale: "macro" },
  { id: "tone", purpose: "Choose the writing tone", scale: "detail" },
];

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), "tasty-"));
  return { root, service: new TastyService(root, new FixedClock(), new FixedIds()) };
}

describe("Tasty vertical flow", () => {
  it("starts, adapts, persists, resumes, reports progress, and compiles immutable versions", async () => {
    const { root, service } = await harness();
    const exactTarget = "  우리 팀의 README 방향을 정하고 싶어요 ✨  ";
    let session = await service.start({
      target: exactTarget,
      estimatedRounds: 2,
      plan: initialPlan,
      references: [
        {
          id: "cieran",
          title: "Cieran",
          url: "https://arxiv.org/abs/2402.15997",
          role: "inspiration",
          note: "Pairwise elicitation inspiration only",
        },
      ],
    });
    expect(session.target).toBe(exactTarget);

    session = await service.present(session.id, {
      planItemId: "direction",
      candidates: [
        { label: "A", text: "Task-first guide", referenceIds: ["cieran"] },
        { label: "B", text: "Concept-first reference" },
      ],
    });
    expect(progress(session).display).toBe("(1/2 예정)");
    session = await service.choose(session.id, { choice: "A", reason: "Readers arrive with a task" });

    const revisedPlan: PlanItem[] = [
      ...initialPlan,
      { id: "examples", purpose: "Choose example density", scale: "detail" },
    ];
    session = await service.revise(session.id, {
      estimatedRounds: 3,
      reason: "The first answer exposed a separate examples decision",
      items: revisedPlan,
    });
    expect(progress(session)).toMatchObject({
      display: "(1/3 예정)",
      explanation:
        "예상 질문 수가 2개에서 3개로 변경되었습니다: The first answer exposed a separate examples decision",
    });

    session = await service.present(session.id, {
      planItemId: "tone",
      candidates: [
        { label: "A", text: "Concise and formal" },
        { label: "B", text: "Friendly and conversational" },
      ],
    });
    session = await service.choose(session.id, {
      choice: "M",
      resolution: "Concise, with friendly examples",
      reason: "Both qualities matter",
    });
    session = await service.complete(session.id);

    const resumed = await new TastyService(root).resume(session.id);
    expect(resumed).toEqual(session);
    expect(resumed.status).toBe("complete");

    const first = await service.compile(session.id);
    const firstTaste = await readFile(first.files[0], "utf8");
    const machine = parse(await readFile(first.files[1], "utf8")) as Record<string, unknown>;
    const receipt = await readFile(first.files[2], "utf8");
    expect(first.version).toBe(1);
    expect(firstTaste).toContain("Task-first guide");
    expect(firstTaste).toContain("References below informed or inspired candidates");
    expect(machine).toMatchObject({ schema_version: 1, profile_version: 1, target: exactTarget });
    expect(receipt).toContain("2 → 3");

    const second = await service.compile(session.id);
    expect(second.version).toBe(2);
    expect(second.directory).not.toBe(first.directory);
    expect(await readFile(first.files[0], "utf8")).toBe(firstTaste);

    const events = await service.store.events(session.id);
    expect(events.map((event) => event.type)).toEqual([
      "session_started",
      "plan_created",
      "comparison_presented",
      "choice_recorded",
      "plan_revised",
      "comparison_presented",
      "choice_recorded",
      "session_completed",
      "profile_compiled",
      "profile_compiled",
    ]);
    expect((await stat(path.join(root, ".tasty", "sessions", session.id, "events.jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("validates choice semantics, active comparisons, provenance, and revisions", async () => {
    const { service } = await harness();
    let session = await service.start({ target: "API style", estimatedRounds: 2, plan: initialPlan });
    await expect(
      service.present(session.id, {
        planItemId: "direction",
        candidates: [
          { label: "A", text: "A", referenceIds: ["missing"] },
          { label: "B", text: "B" },
        ],
      }),
    ).rejects.toThrow("unknown reference");

    session = await service.present(session.id, {
      planItemId: "direction",
      candidates: [
        { label: "A", text: "A" },
        { label: "B", text: "B" },
      ],
    });
    expect(() => recordChoice(session, { choice: "D" })).toThrow("D requires resolution text");
    expect(() => recordChoice(session, { choice: "M" })).toThrow("M requires resolution text");
    await expect(service.revise(session.id, { estimatedRounds: 1, reason: "remove", items: [initialPlan[1]!] })).rejects.toThrow(
      "cannot remove presented items",
    );
    await expect(
      service.present(session.id, {
        planItemId: "tone",
        candidates: [
          { label: "A", text: "A" },
          { label: "B", text: "B" },
        ],
      }),
    ).rejects.toThrow("answer the active comparison first");
  });

  it("keeps the estimated denominator aligned with the decision map", async () => {
    const { service } = await harness();
    await expect(service.start({ target: "README", estimatedRounds: 1, plan: initialPlan })).rejects.toThrow(
      "estimatedRounds must match plan length",
    );

    let session = await service.start({ target: "README", estimatedRounds: 2, plan: initialPlan });
    session = await service.present(session.id, {
      planItemId: "direction",
      candidates: [
        { label: "A", text: "A" },
        { label: "B", text: "B" },
      ],
    });
    session = await service.choose(session.id, { choice: "A" });

    await expect(
      service.revise(session.id, {
        estimatedRounds: 3,
        reason: "No third decision was actually planned",
        items: initialPlan,
      }),
    ).rejects.toThrow("estimatedRounds must match plan length");
  });

  it("presents decision-map items in macro-to-detail order", async () => {
    const { service } = await harness();
    const session = await service.start({ target: "README", estimatedRounds: 2, plan: initialPlan });

    await expect(
      service.present(session.id, {
        planItemId: "tone",
        candidates: [
          { label: "A", text: "A" },
          { label: "B", text: "B" },
        ],
      }),
    ).rejects.toThrow("next plan item is direction");
  });

  it("requires a completed session before compiling a profile", async () => {
    const { service } = await harness();
    let session = await service.start({ target: "README", estimatedRounds: 1, plan: [initialPlan[0]!] });
    session = await service.present(session.id, {
      planItemId: "direction",
      candidates: [
        { label: "A", text: "A" },
        { label: "B", text: "B" },
      ],
    });
    session = await service.choose(session.id, { choice: "A" });

    await expect(service.compile(session.id)).rejects.toThrow("session must be complete before compiling");
  });

  it.each([
    ["A", undefined],
    ["B", undefined],
    ["M", "Hybrid wording"],
    ["N", undefined],
    ["D", "Use my exact standard"],
  ] as const)("records the %s choice", async (choice, resolution) => {
    const { service } = await harness();
    let session = await service.start({ target: choice, estimatedRounds: 1, plan: [initialPlan[0]!] });
    session = await service.present(session.id, {
      planItemId: "direction",
      candidates: [
        { label: "A", text: "A" },
        { label: "B", text: "B" },
      ],
    });
    session = await service.choose(session.id, { choice, ...(resolution ? { resolution } : {}) });
    expect(session.decisions[0]).toMatchObject({ choice, ...(resolution ? { resolution } : {}) });
  });
});
