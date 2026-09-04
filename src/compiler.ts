import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import type { Candidate, Decision, SessionEvent, TasteSession } from "./types.js";

export interface CompiledProfile {
  version: number;
  directory: string;
  files: [string, string, string];
  event: SessionEvent;
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

export async function compileProfile(rootDir: string, session: TasteSession, now: string): Promise<CompiledProfile> {
  if (session.decisions.length === 0) throw new Error("cannot compile an empty profile");
  const profileRoot = path.join(rootDir, "profiles", slug(session.target));
  await mkdir(profileRoot, { recursive: true });

  let version = Math.max(0, ...session.compiledVersions) + 1;
  let directory: string;
  while (true) {
    directory = path.join(profileRoot, `v${String(version).padStart(4, "0")}`);
    try {
      await mkdir(directory);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      version += 1;
    }
  }

  const resolved = session.decisions.map((decision) => {
    const comparison = session.comparisons.find((item) => item.id === decision.comparisonId);
    if (!comparison) throw new Error(`missing comparison for ${decision.comparisonId}`);
    return {
      purpose: comparison.purpose,
      choice: decision.choice,
      preference: selectedText(decision, comparison.candidates),
      reason: decision.reason,
      candidates: comparison.candidates,
    };
  });
  const referenceById = new Map(session.references.map((reference) => [reference.id, reference]));
  const usedReferenceIds = new Set(resolved.flatMap((entry) => entry.candidates.flatMap((candidate) => candidate.referenceIds ?? [])));
  const references = [...usedReferenceIds].map((id) => referenceById.get(id)).filter((value) => value !== undefined);

  const yamlDocument = {
    schema_version: 1,
    profile_version: version,
    target: session.target,
    compiled_at: now,
    source_session: session.id,
    preferences: resolved.map(({ candidates: _candidates, ...entry }) => entry),
    references,
    provenance_policy: "References are context; recorded choices are user preferences, not research facts.",
  };
  const tasteMd = [
    `# Taste Profile: ${session.target}`,
    "",
    `Version: ${version}`,
    `Source session: \`${session.id}\``,
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
    writeFile(files[0], tasteMd, { encoding: "utf8", flag: "wx" }),
    writeFile(files[1], stringify(yamlDocument), { encoding: "utf8", flag: "wx" }),
    writeFile(files[2], receipt, { encoding: "utf8", flag: "wx" }),
  ]);
  return {
    version,
    directory,
    files,
    event: { type: "profile_compiled", at: now, version, path: path.relative(rootDir, directory) },
  };
}
