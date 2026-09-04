import { mkdtemp, mkdir, symlink } from "node:fs/promises";
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
