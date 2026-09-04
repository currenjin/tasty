import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { Candidate, Decision, ProfileSynthesis, SessionEvent, TasteSession } from "./types.js";
import { assertNoSymbolicLinks, readUtf8NoFollow, writeUtf8ExclusiveNoFollow } from "./filesystem.js";

export interface CompiledProfile {
  version: number;
  directory: string;
  files: [string, string, string];
  event: SessionEvent;
}

type ResolvedPreference = {
  purpose: string;
  choice: Decision["choice"];
  preference: string;
  reason?: string;
};

type MachineSynthesis = {
  summary: string;
  confirmed_rules: ProfileSynthesis["confirmedRules"];
  anti_rules: ProfileSynthesis["antiRules"];
  contextual_rules: ProfileSynthesis["contextualRules"];
  unresolved: string[];
  decision_boundaries: string[];
};

interface MachineProfile {
  schema_version: number;
  profile_version: number;
  target: string;
  compiled_at: string;
  source_session: string;
  preferences: ResolvedPreference[];
  synthesis: MachineSynthesis;
  references: TasteSession["references"];
  provenance_policy: string;
}

function slug(value: string): string {
  const result = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return result || "taste-profile";
}

function selectedText(decision: Decision, candidates: [Candidate, Candidate]): string {
  if (decision.choice === "A") return candidates[0].text;
  if (decision.choice === "B") return candidates[1].text;
  if (decision.choice === "M" || decision.choice === "D") return decision.resolution ?? "";
  return "Neither candidate was accepted.";
}

function resolvedPreferences(session: TasteSession): ResolvedPreference[] {
  return session.decisions.map((decision) => {
    const comparison = session.comparisons.find((item) => item.id === decision.comparisonId);
    if (!comparison) throw new Error(`missing comparison for ${decision.comparisonId}`);
    return {
      purpose: comparison.purpose,
      choice: decision.choice,
      preference: selectedText(decision, comparison.candidates),
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  });
}

function usedReferences(session: TasteSession): TasteSession["references"] {
  const referenceById = new Map(session.references.map((reference) => [reference.id, reference]));
  const ids = new Set(
    session.comparisons.flatMap((comparison) => comparison.candidates.flatMap((candidate) => candidate.referenceIds ?? [])),
  );
  return [...ids].map((id) => referenceById.get(id)).filter((value) => value !== undefined);
}

function defaultSynthesis(session: TasteSession): ProfileSynthesis {
  const confirmedRules = session.decisions.flatMap((decision) => {
    const comparison = session.comparisons.find((item) => item.id === decision.comparisonId);
    if (!comparison || decision.choice === "N") return [];
    return [{ rule: selectedText(decision, comparison.candidates), evidenceComparisonIds: [comparison.id] }];
  });
  const antiRules = session.decisions.flatMap((decision) => {
    const comparison = session.comparisons.find((item) => item.id === decision.comparisonId);
    if (!comparison || decision.choice !== "N") return [];
    return comparison.candidates.map((candidate) => ({ rule: candidate.text, evidenceComparisonIds: [comparison.id] }));
  });
  return {
    summary: `Decisions compiled for ${session.target}`,
    confirmedRules,
    antiRules,
    contextualRules: [],
    unresolved: [],
    decisionBoundaries: [],
  };
}

function validateSynthesis(session: TasteSession, synthesis: ProfileSynthesis): void {
  if (!synthesis.summary.trim()) throw new Error("synthesis summary must not be empty");
  const known = new Set(session.comparisons.map((comparison) => comparison.id));
  const decisions = new Map(session.decisions.map((decision) => [decision.comparisonId, decision]));
  const rules = [...synthesis.confirmedRules, ...synthesis.antiRules, ...synthesis.contextualRules];
  for (const entry of rules) {
    if (!entry.rule.trim()) throw new Error("synthesis rule must not be empty");
    if (entry.evidenceComparisonIds.length === 0) throw new Error("synthesis rule requires evidence");
    for (const id of entry.evidenceComparisonIds) {
      if (!known.has(id)) throw new Error(`unknown synthesis evidence: ${id}`);
      if (!decisions.has(id)) throw new Error(`synthesis evidence is undecided: ${id}`);
    }
  }
  for (const entry of [...synthesis.confirmedRules, ...synthesis.contextualRules]) {
    for (const id of entry.evidenceComparisonIds) {
      if (decisions.get(id)?.choice === "N") {
        throw new Error(`accepting-rule evidence requires an accepting choice: ${id}`);
      }
    }
  }
  for (const entry of synthesis.contextualRules) {
    if (!entry.context.trim()) throw new Error("contextual rule context must not be empty");
  }
  for (const item of synthesis.unresolved) {
    if (!item.trim()) throw new Error("unresolved item must not be empty");
  }
  for (const boundary of synthesis.decisionBoundaries) {
    if (!boundary.trim()) throw new Error("decision boundary must not be empty");
  }
}

function ruleLines(entries: { rule: string; evidenceComparisonIds: string[] }[]): string[] {
  return entries.length
    ? entries.flatMap((entry) => [`- ${entry.rule}`, `  - Evidence: ${entry.evidenceComparisonIds.join(", ")}`])
    : ["- None"];
}

function renderTasteMarkdown(
  session: TasteSession,
  version: number,
  synthesis: ProfileSynthesis,
  resolved: ResolvedPreference[],
  references: TasteSession["references"],
): string {
  return [
    `# Taste Profile: ${session.target}`,
    "",
    `Version: ${version}`,
    `Source session: \`${session.id}\``,
    "",
    "## Summary",
    synthesis.summary,
    "",
    "## Confirmed rules",
    ...ruleLines(synthesis.confirmedRules),
    "",
    "## Avoid",
    ...ruleLines(synthesis.antiRules),
    "",
    "## Contextual rules",
    ...(synthesis.contextualRules.length
      ? synthesis.contextualRules.flatMap((entry) => [
          `- **${entry.context}:** ${entry.rule}`,
          `  - Evidence: ${entry.evidenceComparisonIds.join(", ")}`,
        ])
      : ["- None"]),
    "",
    "## Unresolved",
    ...(synthesis.unresolved.length ? synthesis.unresolved.map((entry) => `- ${entry}`) : ["- None"]),
    "",
    "## Decision boundaries",
    ...(synthesis.decisionBoundaries.length ? synthesis.decisionBoundaries.map((entry) => `- ${entry}`) : ["- None"]),
    "",
    "## Preferences",
    ...resolved.flatMap((entry) => [
      `### ${entry.purpose}`,
      `- Choice: **${entry.choice}**`,
      `- Preference: ${entry.preference}`,
      ...(entry.reason ? [`- Reason: ${entry.reason}`] : []),
      "",
    ]),
    "## Provenance",
    "References below informed or inspired candidates. They are not treated as user preferences or proof of claims.",
    ...references.map((reference) => `- [${reference.role}] ${reference.title}${reference.url ? ` — ${reference.url}` : ""}`),
    "",
  ].join("\n");
}

export async function compileProfile(
  rootDir: string,
  session: TasteSession,
  now: string,
  providedSynthesis?: ProfileSynthesis,
): Promise<CompiledProfile> {
  if (session.decisions.length === 0) throw new Error("cannot compile an empty profile");
  const synthesis = structuredClone(providedSynthesis ?? defaultSynthesis(session));
  validateSynthesis(session, synthesis);
  const profileRoot = path.join(rootDir, "profiles", slug(session.target));
  await assertNoSymbolicLinks(rootDir, profileRoot);
  await mkdir(profileRoot, { recursive: true });
  await assertNoSymbolicLinks(rootDir, profileRoot);

  let version = Math.max(0, ...session.compiledVersions) + 1;
  let directory: string;
  while (true) {
    directory = path.join(profileRoot, `v${String(version).padStart(4, "0")}`);
    try {
      await mkdir(directory);
      await assertNoSymbolicLinks(rootDir, directory);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      version += 1;
    }
  }

  const resolved = resolvedPreferences(session);
  const references = usedReferences(session);
  const yamlDocument: MachineProfile = {
    schema_version: 1,
    profile_version: version,
    target: session.target,
    compiled_at: now,
    source_session: session.id,
    preferences: resolved,
    synthesis: {
      summary: synthesis.summary,
      confirmed_rules: synthesis.confirmedRules,
      anti_rules: synthesis.antiRules,
      contextual_rules: synthesis.contextualRules,
      unresolved: synthesis.unresolved,
      decision_boundaries: synthesis.decisionBoundaries,
    },
    references,
    provenance_policy: "References are context; recorded choices are user preferences, not research facts.",
  };
  const tasteMd = renderTasteMarkdown(session, version, synthesis, resolved, references);
  const receipt = [
    `# Decision Receipt — v${String(version).padStart(4, "0")}`,
    "",
    `- Target: ${session.target}`,
    `- Session: ${session.id}`,
    `- Compiled: ${now}`,
    `- Decisions: ${resolved.length}`,
    `- Estimate revisions: ${session.revisions.length}`,
    "",
    "## Decision trail",
    ...resolved.map((entry, index) => `${index + 1}. **${entry.purpose}** → ${entry.choice}: ${entry.preference}${entry.reason ? ` _(reason: ${entry.reason})_` : ""}`),
    "",
    "## Plan revisions",
    ...(session.revisions.length
      ? session.revisions.map((entry) => `- ${entry.previousEstimate} → ${entry.newEstimate}: ${entry.reason}`)
      : ["- None"]),
    "",
  ].join("\n");

  const files: [string, string, string] = [
    path.join(directory, "TASTE.md"),
    path.join(directory, "taste.yaml"),
    path.join(directory, "decision-receipt.md"),
  ];
  await Promise.all([
    writeUtf8ExclusiveNoFollow(files[0], tasteMd),
    writeUtf8ExclusiveNoFollow(files[1], stringify(yamlDocument)),
    writeUtf8ExclusiveNoFollow(files[2], receipt),
  ]);
  return {
    version,
    directory,
    files,
    event: { type: "profile_compiled", at: now, version, path: path.relative(rootDir, directory) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`compiled profile has invalid ${field}`);
  return value;
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`compiled profile has invalid ${field}`);
  }
  return value;
}

function readRules(value: unknown, field: string, contextual = false): ProfileSynthesis["contextualRules"] {
  if (!Array.isArray(value)) throw new Error(`compiled profile has invalid ${field}`);
  return value.map((item) => {
    if (!isRecord(item)) throw new Error(`compiled profile has invalid ${field}`);
    const rule = readString(item.rule, `${field}.rule`);
    const evidenceComparisonIds = readStringArray(item.evidenceComparisonIds, `${field}.evidenceComparisonIds`);
    if (contextual) return { rule, evidenceComparisonIds, context: readString(item.context, `${field}.context`) };
    return { rule, evidenceComparisonIds, context: "" };
  });
}

function parseMachineProfile(value: unknown, session: TasteSession, version: number): { machine: MachineProfile; synthesis: ProfileSynthesis } {
  if (!isRecord(value)) throw new Error("compiled profile must be an object");
  if (value.schema_version !== 1) throw new Error("unsupported compiled profile schema");
  if (value.profile_version !== version) throw new Error("compiled profile version does not match");
  if (value.source_session !== session.id) throw new Error("compiled profile source session does not match");
  if (value.target !== session.target) throw new Error("compiled profile target does not match");
  if (typeof value.compiled_at !== "string" || Number.isNaN(Date.parse(value.compiled_at))) {
    throw new Error("compiled profile has invalid compiled_at");
  }
  if (!Array.isArray(value.preferences) || !Array.isArray(value.references) || !isRecord(value.synthesis)) {
    throw new Error("compiled profile has invalid structure");
  }
  const s = value.synthesis;
  const confirmedRules = readRules(s.confirmed_rules, "confirmed_rules").map(({ rule, evidenceComparisonIds }) => ({
    rule,
    evidenceComparisonIds,
  }));
  const antiRules = readRules(s.anti_rules, "anti_rules").map(({ rule, evidenceComparisonIds }) => ({
    rule,
    evidenceComparisonIds,
  }));
  const contextualRules = readRules(s.contextual_rules, "contextual_rules", true);
  const synthesis: ProfileSynthesis = {
    summary: readString(s.summary, "synthesis.summary"),
    confirmedRules,
    antiRules,
    contextualRules,
    unresolved: readStringArray(s.unresolved, "synthesis.unresolved"),
    decisionBoundaries: readStringArray(s.decision_boundaries, "synthesis.decision_boundaries"),
  };
  validateSynthesis(session, synthesis);

  const expectedPreferences = resolvedPreferences(session);
  const expectedReferences = usedReferences(session);
  if (JSON.stringify(value.preferences) !== JSON.stringify(expectedPreferences)) {
    throw new Error("compiled profile preferences do not match source session");
  }
  if (JSON.stringify(value.references) !== JSON.stringify(expectedReferences)) {
    throw new Error("compiled profile references do not match source session");
  }
  readString(value.provenance_policy, "provenance_policy");
  return { machine: value as unknown as MachineProfile, synthesis };
}

export interface AppliedProfile {
  version: number;
  directory: string;
  markdown: string;
  machine: MachineProfile;
}

export async function loadCompiledProfile(
  rootDir: string,
  session: TasteSession,
  requestedVersion?: number,
): Promise<AppliedProfile> {
  const version = requestedVersion ?? Math.max(0, ...session.compiledVersions);
  if (!version || !session.compiledVersions.includes(version)) throw new Error("compiled profile version not found");
  const directory = path.join(rootDir, "profiles", slug(session.target), `v${String(version).padStart(4, "0")}`);
  await assertNoSymbolicLinks(rootDir, directory);
  const [markdown, rawMachine] = await Promise.all([
    readUtf8NoFollow(path.join(directory, "TASTE.md")),
    readUtf8NoFollow(path.join(directory, "taste.yaml")),
  ]);
  const parsed = parseMachineProfile(parse(rawMachine), session, version);
  const expectedMarkdown = renderTasteMarkdown(
    session,
    version,
    parsed.synthesis,
    parsed.machine.preferences,
    parsed.machine.references,
  );
  if (markdown !== expectedMarkdown) throw new Error("compiled profile Markdown does not match machine profile");
  return { version, directory, markdown, machine: parsed.machine };
}
