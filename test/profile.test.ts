import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { TastyService } from "../src/service.js";
import type { PlanItem, ProfileSynthesis } from "../src/types.js";

const plan: PlanItem[] = [
  { id: "direction", purpose: "Choose the overall direction", scale: "macro" },
  { id: "tone", purpose: "Choose the tone", scale: "detail" },
];

const synthesis: ProfileSynthesis = {
  summary: "Lead with action while retaining concise rationale.",
  confirmedRules: [
    {
      rule: "Lead with the first executable action.",
      evidenceComparisonIds: ["cmp_2"],
    },
  ],
  antiRules: [
    {
      rule: "Do not begin with an abstract marketing introduction.",
      evidenceComparisonIds: ["cmp_2"],
    },
  ],
  contextualRules: [
    {
      context: "When a decision changes user behavior",
      rule: "Include a one-sentence rationale.",
      evidenceComparisonIds: ["cmp_3"],
    },
  ],
  unresolved: ["Badge placement"],
  decisionBoundaries: ["Concise does not mean removing required context."],
};

async function completedSession() {
  const root = await mkdtemp(path.join(tmpdir(), "tasty-profile-"));
  const service = new TastyService(root, { now: () => "2026-09-04T00:00:00.000Z" }, {
    next: (() => {
      let index = 0;
      return (prefix: string) => `${prefix}_${++index}`;
    })(),
  });
  let session = await service.start({ target: "README direction", estimatedRounds: 2, plan });
  session = await service.present(session.id, {
    planItemId: "direction",
    candidates: [
      { label: "A", text: "Action first" },
      { label: "B", text: "Concept first" },
    ],
  });
  session = await service.choose(session.id, { choice: "A", reason: "Readers arrive with a task" });
  session = await service.present(session.id, {
    planItemId: "tone",
    candidates: [
      { label: "A", text: "Concise with rationale" },
      { label: "B", text: "Minimal without rationale" },
    ],
  });
  session = await service.choose(session.id, { choice: "A" });
  session = await service.complete(session.id);
  return { root, service, session };
}

describe("Taste Profile synthesis and application", () => {
  it("compiles generalized, evidenced rules instead of only copying winners", async () => {
    const { service, session } = await completedSession();

    const compiled = await service.compile(session.id, synthesis);
    const markdown = await readFile(compiled.files[0], "utf8");
    const machine = parse(await readFile(compiled.files[1], "utf8")) as Record<string, unknown>;

    expect(markdown).toContain("## Confirmed rules");
    expect(markdown).toContain("Lead with the first executable action.");
    expect(markdown).toContain("## Avoid");
    expect(markdown).toContain("## Contextual rules");
    expect(markdown).toContain("## Unresolved");
    expect(markdown).toContain("## Decision boundaries");
    expect(machine).toMatchObject({
      synthesis: {
        summary: synthesis.summary,
        confirmed_rules: synthesis.confirmedRules,
        anti_rules: synthesis.antiRules,
        contextual_rules: synthesis.contextualRules,
        unresolved: synthesis.unresolved,
        decision_boundaries: synthesis.decisionBoundaries,
      },
    });
  });

  it("rejects synthesis evidence that is not a recorded comparison", async () => {
    const { service, session } = await completedSession();
    const invalid: ProfileSynthesis = {
      ...synthesis,
      confirmedRules: [{ rule: "Invented", evidenceComparisonIds: ["cmp_missing"] }],
    };

    await expect(service.compile(session.id, invalid)).rejects.toThrow("unknown synthesis evidence: cmp_missing");
  });

  it("rejects accepting-rule evidence from a comparison where neither candidate was accepted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tasty-profile-rejection-"));
    const service = new TastyService(root, { now: () => "2026-09-04T00:00:00.000Z" });
    let rejected = await service.start({ target: "README direction", estimatedRounds: 1, plan: [plan[0]!] });
    rejected = await service.present(rejected.id, {
      planItemId: "direction",
      candidates: [{ label: "A", text: "Action first" }, { label: "B", text: "Concept first" }],
    });
    const comparisonId = rejected.comparisons[0]!.id;
    rejected = await service.choose(rejected.id, { choice: "N", reason: "Neither direction fits" });
    rejected = await service.complete(rejected.id);
    const invalid: ProfileSynthesis = {
      ...synthesis,
      confirmedRules: [{ rule: "Treat a rejected direction as accepted", evidenceComparisonIds: [comparisonId] }],
      antiRules: [],
      contextualRules: [],
    };

    await expect(service.compile(rejected.id, invalid)).rejects.toThrow(
      `accepting-rule evidence requires an accepting choice: ${comparisonId}`,
    );
  });

  it("loads the latest compiled profile as prompt-ready application context", async () => {
    const { service, session } = await completedSession();
    await service.compile(session.id, synthesis);
    const second = await service.compile(session.id, {
      ...synthesis,
      summary: "Second version",
    });

    const applied = await service.apply(session.id);

    expect(applied.version).toBe(2);
    expect(applied.directory).toBe(second.directory);
    expect(applied.markdown).toContain("Second version");
    expect(applied.machine.synthesis.summary).toBe("Second version");
  });

  it.each([
    ["schema", { schema_version: 2 }, "unsupported compiled profile schema"],
    ["version", { profile_version: 99 }, "compiled profile version does not match"],
    ["session", { source_session: "tasty_forged" }, "compiled profile source session does not match"],
    ["target", { target: "forged" }, "compiled profile target does not match"],
  ])("rejects a compiled profile with a forged %s binding", async (_label, mutation, message) => {
    const { service, session } = await completedSession();
    const compiled = await service.compile(session.id, synthesis);
    const profilePath = compiled.files[1];
    const machine = parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
    await writeFile(profilePath, JSON.stringify({ ...machine, ...mutation }));

    await expect(service.apply(session.id, compiled.version)).rejects.toThrow(message);
  });
});
