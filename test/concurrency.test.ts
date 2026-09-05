import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { reduceEvents } from "../src/core.js";
import { TastyService } from "../src/service.js";
import type { SessionEvent } from "../src/types.js";

let root: string;
let service: TastyService;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "tasty-concurrency-"));
  service = new TastyService(root);
});

const plan = [
  { id: "direction", purpose: "Choose the overall direction", scale: "macro" as const },
  { id: "examples", purpose: "Choose example density", scale: "detail" as const },
];

const candidates: [
  { label: "A"; text: string },
  { label: "B"; text: string },
] = [
  { label: "A", text: "Task-first guide" },
  { label: "B", text: "Concept-first reference" },
];

async function startSession(): Promise<string> {
  const session = await service.start({ target: "README direction", estimatedRounds: 2, plan });
  return session.id;
}

/** Reads the raw log and replays it, which is the fail-closed guarantee every writer must preserve. */
async function replay(sessionId: string): Promise<ReturnType<typeof reduceEvents>> {
  const raw = await readFile(path.join(root, ".tasty", "sessions", sessionId, "events.jsonl"), "utf8");
  const events = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEvent);
  return reduceEvents(events);
}

function rejections(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
}

describe("per-session mutation boundary", () => {
  it("records exactly one choice when concurrent callers answer the same comparison", async () => {
    const sessionId = await startSession();
    await service.present(sessionId, { planItemId: "direction", candidates });

    const results = await Promise.allSettled([
      service.choose(sessionId, { choice: "A" }),
      service.choose(sessionId, { choice: "B" }),
      service.choose(sessionId, { choice: "N" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rejections(results)).toEqual([
      expect.stringContaining("no active comparison"),
      expect.stringContaining("no active comparison"),
    ]);
    const replayed = await replay(sessionId);
    expect(replayed.decisions).toHaveLength(1);
  });

  it("presents a plan item once when concurrent callers race to present it", async () => {
    const sessionId = await startSession();

    const results = await Promise.allSettled([
      service.present(sessionId, { planItemId: "direction", candidates }),
      service.present(sessionId, { planItemId: "direction", candidates }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rejections(results)).toEqual([expect.stringContaining("answer the active comparison first")]);
    expect((await replay(sessionId)).comparisons).toHaveLength(1);
  });

  it("keeps the log replayable when concurrent callers revise the estimate to different values", async () => {
    const sessionId = await startSession();
    const wider = [...plan, { id: "tone", purpose: "Choose the tone", scale: "detail" as const }];
    // Each writer must observe the estimate left by the writer before it, or replay rejects the log.
    const revisions = Array.from({ length: 6 }, (_, index) =>
      index % 2 === 0
        ? { estimatedRounds: 3, reason: `widen ${index}`, items: wider }
        : { estimatedRounds: 2, reason: `narrow ${index}`, items: plan },
    );

    const results = await Promise.allSettled(revisions.map((revision) => service.revise(sessionId, revision)));

    expect(rejections(results)).toEqual([]);
    const replayed = await replay(sessionId);
    expect(replayed.revisions).toHaveLength(6);
    expect(replayed.estimatedRounds).toBe(replayed.plan.length);
  });

  it("allocates a distinct profile version per concurrent compile and keeps the log replayable", async () => {
    const sessionId = await startSession();
    for (const item of plan) {
      await service.present(sessionId, { planItemId: item.id, candidates });
      await service.choose(sessionId, { choice: "A" });
    }
    await service.complete(sessionId);

    const results = await Promise.all([service.compile(sessionId), service.compile(sessionId)]);

    expect(results.map((compiled) => compiled.version).sort()).toEqual([1, 2]);
    expect((await replay(sessionId)).compiledVersions.sort()).toEqual([1, 2]);
  });

  it("reports an unknown session instead of failing inside the mutation boundary", async () => {
    await expect(service.choose("tasty_missing", { choice: "A" })).rejects.toThrow(/unknown session/);
  });

  it("still refuses a session id that escapes the sessions directory", async () => {
    await expect(service.choose("../../etc", { choice: "A" })).rejects.toThrow(/invalid session id/);
  });

  it("refuses to mutate when the lock path has been replaced by a symbolic link", async () => {
    const sessionId = await startSession();
    await service.present(sessionId, { planItemId: "direction", candidates });
    const elsewhere = path.join(root, "elsewhere");
    await writeFile(elsewhere, "", "utf8");
    await symlink(elsewhere, path.join(root, ".tasty", "sessions", sessionId, "session.lock"));

    await expect(service.choose(sessionId, { choice: "A" })).rejects.toThrow(/symbolic link|ELOOP/);
    expect((await replay(sessionId)).decisions).toHaveLength(0);
  });
});
