import { mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reduceEvents, startEvents } from "../src/core.js";
import { TastyService } from "../src/service.js";
import type { PlanItem, SessionEvent } from "../src/types.js";

const macro: PlanItem = { id: "direction", purpose: "Choose direction", scale: "macro" };
const detail: PlanItem = { id: "tone", purpose: "Choose tone", scale: "detail" };

async function root(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "tasty-invariants-"));
}

describe("state invariants", () => {
  it("rejects invalid or detail-first plans", () => {
    expect(() => startEvents({ target: "x", estimatedRounds: 2, plan: [detail, macro] })).toThrow(
      "macro plan items must precede detail items",
    );
    expect(() => startEvents({ target: "x", estimatedRounds: 2, plan: [macro, { ...macro }] })).toThrow(
      "plan item ids must be unique",
    );
    expect(() => startEvents({ target: "x", estimatedRounds: 1, plan: [{ ...macro, purpose: " " }] })).toThrow(
      "plan item purpose must not be empty",
    );
  });

  it("requires every planned comparison before completion", async () => {
    const service = new TastyService(await root());
    let session = await service.start({ target: "x", estimatedRounds: 2, plan: [macro, detail] });
    session = await service.present(session.id, {
      planItemId: macro.id,
      candidates: [{ label: "A", text: "A" }, { label: "B", text: "B" }],
    });
    session = await service.choose(session.id, { choice: "A" });
    await expect(service.complete(session.id)).rejects.toThrow("all planned comparisons must be decided");
  });

  it("keeps completion terminal", async () => {
    const service = new TastyService(await root());
    let session = await service.start({ target: "x", estimatedRounds: 1, plan: [macro] });
    session = await service.present(session.id, {
      planItemId: macro.id,
      candidates: [{ label: "A", text: "A" }, { label: "B", text: "B" }],
    });
    session = await service.choose(session.id, { choice: "A" });
    session = await service.complete(session.id);
    await expect(service.complete(session.id)).rejects.toThrow("session is complete");
    await expect(service.revise(session.id, { estimatedRounds: 1, reason: "change", items: [macro] })).rejects.toThrow(
      "session is complete",
    );
  });

  it("preserves presented plan items across revisions", async () => {
    const service = new TastyService(await root());
    let session = await service.start({ target: "x", estimatedRounds: 2, plan: [macro, detail] });
    session = await service.present(session.id, {
      planItemId: macro.id,
      candidates: [{ label: "A", text: "A" }, { label: "B", text: "B" }],
    });
    session = await service.choose(session.id, { choice: "A" });
    await expect(
      service.revise(session.id, {
        estimatedRounds: 2,
        reason: "mutate history",
        items: [{ ...macro, purpose: "Changed" }, detail],
      }),
    ).rejects.toThrow("presented plan items cannot change");
  });

  it("fails closed when replaying an impossible event order", () => {
    const at = "2026-09-04T00:00:00.000Z";
    const events: SessionEvent[] = [
      { type: "session_started", at, sessionId: "tasty_x", target: "x" },
      { type: "plan_created", at, estimatedRounds: 1, items: [macro], references: [] },
      { type: "session_completed", at },
    ];
    expect(() => reduceEvents(events)).toThrow("all planned comparisons must be decided");
  });

  it("fails closed on malformed, duplicate, and out-of-order comparison events", () => {
    const at = "2026-09-04T00:00:00.000Z";
    const base: SessionEvent[] = [
      { type: "session_started", at, sessionId: "tasty_x", target: "x" },
      { type: "plan_created", at, estimatedRounds: 1, items: [macro], references: [] },
    ];
    const comparison: Extract<SessionEvent, { type: "comparison_presented" }> = {
      type: "comparison_presented",
      at,
      comparison: {
        id: "cmp_1",
        planItemId: macro.id,
        purpose: macro.purpose,
        candidates: [{ label: "A", text: "A" }, { label: "B", text: "B" }],
        presentedAt: at,
      },
    };
    expect(() => reduceEvents([...base, comparison, comparison])).toThrow("answer the active comparison first");
    expect(() => reduceEvents([...base, { ...comparison, comparison: { ...comparison.comparison, purpose: "forged" } }])).toThrow(
      "comparison purpose must match plan item",
    );
    expect(() => reduceEvents([...base, {
      ...comparison,
      comparison: {
        ...comparison.comparison,
        candidates: [{ label: "B", text: "A" }, { label: "A", text: "B" }],
      } as typeof comparison.comparison,
    }])).toThrow("candidates must be ordered A then B");
  });

  it("fails closed on forged choices, compile events, and timestamps", () => {
    const at = "2026-09-04T00:00:00.000Z";
    const compared: SessionEvent[] = [
      { type: "session_started", at, sessionId: "tasty_x", target: "x" },
      { type: "plan_created", at, estimatedRounds: 1, items: [macro], references: [] },
      {
        type: "comparison_presented",
        at,
        comparison: {
          id: "cmp_1",
          planItemId: macro.id,
          purpose: macro.purpose,
          candidates: [{ label: "A", text: "A" }, { label: "B", text: "B" }],
          presentedAt: at,
        },
      },
    ];
    expect(() => reduceEvents([...compared, { type: "choice_recorded", at, decision: { comparisonId: "cmp_other", choice: "A", decidedAt: at } }])).toThrow(
      "choice must answer the active comparison",
    );
    expect(() => reduceEvents([...compared, { type: "choice_recorded", at, decision: { comparisonId: "cmp_1", choice: "M", decidedAt: at } }])).toThrow(
      "M requires resolution text",
    );
    expect(() => reduceEvents([{ type: "session_started", at: "not-a-date", sessionId: "tasty_x", target: "x" }, ...compared.slice(1)])).toThrow(
      "invalid event timestamp",
    );
    const backwards = "2026-09-03T23:59:59.000Z";
    expect(() => reduceEvents([...compared, { type: "choice_recorded", at: backwards, decision: { comparisonId: "cmp_1", choice: "A", decidedAt: backwards } }])).toThrow(
      "event timestamp cannot go backwards",
    );
    const offsetStart: SessionEvent[] = [
      { type: "session_started", at: "2026-09-04T00:00:00.000+02:00", sessionId: "tasty_x", target: "x" },
      { type: "plan_created", at: "2026-09-03T23:00:00.000Z", estimatedRounds: 1, items: [macro], references: [] },
    ];
    expect(() => reduceEvents(offsetStart)).not.toThrow();
    expect(() => reduceEvents([
      { type: "session_started", at: "2026-09-03T23:00:00.000Z", sessionId: "tasty_x", target: "x" },
      { type: "plan_created", at: "2026-09-04T00:00:00.000+02:00", estimatedRounds: 1, items: [macro], references: [] },
    ])).toThrow("event timestamp cannot go backwards");
    expect(() => reduceEvents([...compared, {
      type: "choice_recorded",
      at,
      decision: { comparisonId: "cmp_1", choice: "A", decidedAt: at, reason: { forged: true } } as never,
    }])).toThrow("decision reason must be a string");
    expect(() => reduceEvents([...compared, { type: "profile_compiled", at, version: 1, path: "profiles/x/v0001" }])).toThrow(
      "profile can only be compiled after completion",
    );
  });

  it("validates an appended transition before writing it", async () => {
    const project = await root();
    const service = new TastyService(project, { now: () => "2026-09-04T00:00:00.000Z" });
    const session = await service.start({ target: "x", estimatedRounds: 1, plan: [macro] });
    const eventFile = path.join(project, ".tasty", "sessions", session.id, "events.jsonl");
    const before = await readFile(eventFile, "utf8");

    await expect(service.store.append(session.id, {
      type: "choice_recorded",
      at: "2026-09-04T00:00:00.000Z",
      decision: { comparisonId: "cmp_missing", choice: "A", decidedAt: "2026-09-04T00:00:00.000Z" },
    })).rejects.toThrow("there is no active comparison");
    expect(await readFile(eventFile, "utf8")).toBe(before);
  });
});

describe("filesystem containment", () => {
  it("rejects a symlinked private session root", async () => {
    const project = await root();
    const outside = await root();
    await mkdir(path.join(project, ".tasty"));
    await symlink(outside, path.join(project, ".tasty", "sessions"));
    const service = new TastyService(project);
    await expect(service.start({ target: "x", estimatedRounds: 1, plan: [macro] })).rejects.toThrow("symbolic link");
  });

  it("rejects a symlinked profiles root", async () => {
    const project = await root();
    const outside = await root();
    await symlink(outside, path.join(project, "profiles"));
    const service = new TastyService(project);
    let session = await service.start({ target: "x", estimatedRounds: 1, plan: [macro] });
    session = await service.present(session.id, {
      planItemId: macro.id,
      candidates: [{ label: "A", text: "A" }, { label: "B", text: "B" }],
    });
    session = await service.choose(session.id, { choice: "A" });
    await service.complete(session.id);
    await expect(service.compile(session.id)).rejects.toThrow("symbolic link");
  });
});
