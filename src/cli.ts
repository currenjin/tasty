#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { progress } from "./core.js";
import { TastyService } from "./service.js";
import type {
  Candidate,
  ChoiceType,
  ContextualRule,
  EvidencedRule,
  PlanItem,
  ProfileSynthesis,
  Reference,
} from "./types.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export interface CliStreams {
  cwd: string;
  stdout(chunk: string): void;
  stderr(chunk: string): void;
}

/** Signals a caller mistake (bad command, flag, or input shape) rather than a domain rule violation. */
class UsageError extends Error {}

const CHOICES = ["A", "B", "M", "N", "D"] as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// -- input decoding -----------------------------------------------------------

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageError(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`${field} must be a non-empty string`);
  return value;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : asString(value, field);
}

function asPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new UsageError(`${field} must be a positive integer`);
  }
  return value;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new UsageError(`${field} must be a JSON array`);
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  return asArray(value, field).map((item, index) => asString(item, `${field}[${index}]`));
}

function decodePlan(value: unknown, field: string): PlanItem[] {
  const items = asArray(value, field);
  if (items.length === 0) throw new UsageError(`${field} must contain at least one plan item`);
  return items.map((item, index) => {
    const entry = asRecord(item, `${field}[${index}]`);
    const scale = asString(entry.scale, `${field}[${index}].scale`);
    if (scale !== "macro" && scale !== "detail") {
      throw new UsageError(`${field}[${index}].scale must be "macro" or "detail"`);
    }
    return {
      id: asString(entry.id, `${field}[${index}].id`),
      purpose: asString(entry.purpose, `${field}[${index}].purpose`),
      scale,
    };
  });
}

function decodeReferences(value: unknown, field: string): Reference[] {
  return asArray(value, field).map((item, index) => {
    const entry = asRecord(item, `${field}[${index}]`);
    const role = asString(entry.role, `${field}[${index}].role`);
    if (role !== "evidence" && role !== "inspiration") {
      throw new UsageError(`${field}[${index}].role must be "evidence" or "inspiration"`);
    }
    const url = asOptionalString(entry.url, `${field}[${index}].url`);
    const note = asOptionalString(entry.note, `${field}[${index}].note`);
    return {
      id: asString(entry.id, `${field}[${index}].id`),
      title: asString(entry.title, `${field}[${index}].title`),
      role,
      ...(url !== undefined ? { url } : {}),
      ...(note !== undefined ? { note } : {}),
    };
  });
}

function decodeCandidate(value: unknown, field: string): Candidate {
  const entry = asRecord(value, field);
  const label = asString(entry.label, `${field}.label`);
  if (label !== "A" && label !== "B") throw new UsageError(`${field}.label must be "A" or "B"`);
  const referenceIds = entry.referenceIds === undefined ? undefined : asStringArray(entry.referenceIds, `${field}.referenceIds`);
  return {
    label,
    text: asString(entry.text, `${field}.text`),
    ...(referenceIds !== undefined ? { referenceIds } : {}),
  };
}

function decodeCandidates(value: unknown, field: string): [Candidate, Candidate] {
  const items = asArray(value, field);
  if (items.length !== 2) throw new UsageError(`${field} must contain exactly two candidates, A first and B second`);
  return [decodeCandidate(items[0], `${field}[0]`), decodeCandidate(items[1], `${field}[1]`)];
}

function decodeRule(value: unknown, field: string): EvidencedRule {
  const entry = asRecord(value, field);
  return {
    rule: asString(entry.rule, `${field}.rule`),
    evidenceComparisonIds: asStringArray(entry.evidenceComparisonIds, `${field}.evidenceComparisonIds`),
  };
}

function decodeRules(value: unknown, field: string): EvidencedRule[] {
  return asArray(value, field).map((item, index) => decodeRule(item, `${field}[${index}]`));
}

function decodeContextualRules(value: unknown, field: string): ContextualRule[] {
  return asArray(value, field).map((item, index) => ({
    ...decodeRule(item, `${field}[${index}]`),
    context: asString(asRecord(item, `${field}[${index}]`).context, `${field}[${index}].context`),
  }));
}

function decodeSynthesis(value: unknown): ProfileSynthesis {
  const source = asRecord(value, "synthesis");
  return {
    summary: asString(source.summary, "synthesis.summary"),
    confirmedRules: decodeRules(source.confirmedRules, "synthesis.confirmedRules"),
    antiRules: decodeRules(source.antiRules, "synthesis.antiRules"),
    contextualRules: decodeContextualRules(source.contextualRules, "synthesis.contextualRules"),
    unresolved: asStringArray(source.unresolved, "synthesis.unresolved"),
    decisionBoundaries: asStringArray(source.decisionBoundaries, "synthesis.decisionBoundaries"),
  };
}

function decodeChoice(value: unknown, field: string): ChoiceType {
  const choice = asString(value, field);
  if (!(CHOICES as readonly string[]).includes(choice)) {
    throw new UsageError(`${field} must be one of ${CHOICES.join(", ")}`);
  }
  return choice as ChoiceType;
}

// -- argument parsing ---------------------------------------------------------

interface ParsedArgs {
  help: boolean;
  command?: string;
  positionals: string[];
  options: Map<string, string>;
}

function parseArgv(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false, positionals: [], options: new Map() };
  /** A repeated option is a caller mistake, so it is refused rather than resolved by last-one-wins. */
  const set = (name: string, value: string): void => {
    if (parsed.options.has(name)) throw new UsageError(`--${name} may only be given once`);
    parsed.options.set(name, value);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token.startsWith("--")) {
      const separator = token.indexOf("=");
      const name = separator === -1 ? token.slice(2) : token.slice(2, separator);
      if (!name) throw new UsageError(`invalid option: ${token}`);
      if (separator !== -1) {
        set(name, token.slice(separator + 1));
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`--${name} requires a value`);
      set(name, value);
      index += 1;
      continue;
    }
    if (parsed.command === undefined) parsed.command = token;
    else parsed.positionals.push(token);
  }
  return parsed;
}

async function readStructuredInput(value: string, cwd: string): Promise<unknown> {
  let raw = value;
  let origin = "--input";
  if (value.startsWith("@")) {
    const reference = value.slice(1);
    if (!reference) throw new UsageError("--input @file requires a path");
    origin = `--input file ${reference}`;
    try {
      raw = await readFile(path.resolve(cwd, reference), "utf8");
    } catch (error) {
      throw new UsageError(`cannot read ${origin}: ${message(error)}`);
    }
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`${origin} is not valid JSON: ${message(error)}`);
  }
}

// -- commands -----------------------------------------------------------------

interface CommandContext {
  service: TastyService;
  sessionId: string;
  options: Map<string, string>;
  cwd: string;
}

interface CommandSpec {
  summary: string;
  usage: string;
  session: boolean;
  options: readonly string[];
  run(context: CommandContext): Promise<unknown>;
}

async function structured(context: CommandContext): Promise<unknown> {
  const value = context.options.get("input");
  if (value === undefined) throw new UsageError("--input <json|@file> is required");
  return readStructuredInput(value, context.cwd);
}

/**
 * `--input` supplies the whole payload, so combining it with the equivalent flags would silently
 * drop one of two conflicting sources. Refuse the combination instead of picking a winner.
 */
async function exclusiveStructured(context: CommandContext, conflicting: readonly string[]): Promise<unknown> {
  const present = conflicting.filter((name) => context.options.has(name));
  if (present.length > 0) {
    throw new UsageError(`--input cannot be combined with ${present.map((name) => `--${name}`).join(", ")}`);
  }
  return structured(context);
}

const COMMANDS: Record<string, CommandSpec> = {
  start: {
    summary: "Start a session from a target, estimate, decision map, and optional references.",
    usage: "tasty start --input <json|@file>",
    session: false,
    options: ["input"],
    async run(context) {
      const source = asRecord(await structured(context), "input");
      const references = source.references === undefined ? undefined : decodeReferences(source.references, "references");
      const session = await context.service.start({
        target: asString(source.target, "target"),
        estimatedRounds: asPositiveInteger(source.estimatedRounds, "estimatedRounds"),
        plan: decodePlan(source.plan, "plan"),
        ...(references !== undefined ? { references } : {}),
      });
      return {
        sessionId: session.id,
        target: session.target,
        estimatedRounds: session.estimatedRounds,
        plan: session.plan,
        references: session.references,
        progress: progress(session),
      };
    },
  },
  present: {
    summary: "Persist the next A/B comparison for the next unpresented decision-map item.",
    usage: "tasty present <session-id> --input <json|@file>",
    session: true,
    options: ["input"],
    async run(context) {
      const source = asRecord(await structured(context), "input");
      const session = await context.service.present(context.sessionId, {
        planItemId: asString(source.planItemId, "planItemId"),
        candidates: decodeCandidates(source.candidates, "candidates"),
      });
      return { sessionId: session.id, comparison: session.comparisons.at(-1), progress: progress(session) };
    },
  },
  choose: {
    summary: "Record A, B, M (hybrid), N (neither), or D (direct decision) for the active comparison.",
    usage: "tasty choose <session-id> (--choice <A|B|M|N|D> [--reason <text>] [--resolution <text>] | --input <json|@file>)",
    session: true,
    options: ["input", "choice", "reason", "resolution"],
    async run(context) {
      const source = context.options.has("input")
        ? asRecord(await exclusiveStructured(context, ["choice", "reason", "resolution"]), "input")
        : {
            choice: context.options.get("choice"),
            reason: context.options.get("reason"),
            resolution: context.options.get("resolution"),
          };
      const reason = asOptionalString(source.reason, "reason");
      const resolution = asOptionalString(source.resolution, "resolution");
      const session = await context.service.choose(context.sessionId, {
        choice: decodeChoice(source.choice, "choice"),
        ...(reason !== undefined ? { reason } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      });
      return { sessionId: session.id, decision: session.decisions.at(-1), progress: progress(session) };
    },
  },
  "revise-plan": {
    summary: "Replace the remaining decision map and estimate with a transparent reason.",
    usage: "tasty revise-plan <session-id> --input <json|@file>",
    session: true,
    options: ["input"],
    async run(context) {
      const source = asRecord(await structured(context), "input");
      const session = await context.service.revise(context.sessionId, {
        estimatedRounds: asPositiveInteger(source.estimatedRounds, "estimatedRounds"),
        reason: asString(source.reason, "reason"),
        items: decodePlan(source.plan ?? source.items, "plan"),
      });
      return {
        sessionId: session.id,
        estimatedRounds: session.estimatedRounds,
        plan: session.plan,
        progress: progress(session),
      };
    },
  },
  status: {
    summary: "Report session state and the Korean progress display.",
    usage: "tasty status <session-id>",
    session: true,
    options: [],
    async run(context) {
      return context.service.status(context.sessionId);
    },
  },
  resume: {
    summary: "Reload a session from its append-only event log.",
    usage: "tasty resume <session-id>",
    session: true,
    options: [],
    async run(context) {
      return { session: await context.service.resume(context.sessionId) };
    },
  },
  complete: {
    summary: "Mark a session complete once every planned comparison is answered.",
    usage: "tasty complete <session-id>",
    session: true,
    options: [],
    async run(context) {
      const session = await context.service.complete(context.sessionId);
      return { sessionId: session.id, status: session.status, progress: progress(session) };
    },
  },
  compile: {
    summary: "Compile recorded choices into a new immutable Taste Profile version.",
    usage: "tasty compile <session-id> [--input <json|@file>]",
    session: true,
    options: ["input"],
    async run(context) {
      const compiled = context.options.has("input")
        ? await context.service.compile(context.sessionId, decodeSynthesis(await structured(context)))
        : await context.service.compile(context.sessionId);
      return {
        sessionId: context.sessionId,
        version: compiled.version,
        directory: compiled.directory,
        files: compiled.files,
      };
    },
  },
  apply: {
    summary: "Load the latest or a requested immutable profile as prompt-ready context.",
    usage: "tasty apply <session-id> [--version <n>]",
    session: true,
    options: ["version"],
    async run(context) {
      const raw = context.options.get("version");
      const version = raw === undefined ? undefined : asPositiveInteger(Number(raw), "--version");
      const applied = await context.service.apply(context.sessionId, version);
      return { sessionId: context.sessionId, ...applied };
    },
  },
};

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  return [
    "tasty — a file-based, adaptive pairwise decision assistant",
    "",
    "Usage: tasty [--root <path>] <command> [<session-id>] [options]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(width)}  ${spec.summary}`),
    "",
    "Command usage:",
    ...Object.values(COMMANDS).map((spec) => `  ${spec.usage}`),
    "",
    "Global options:",
    "  --root <path>   Workspace directory holding .tasty/ and profiles/ (default: current directory)",
    "  -h, --help      Print this help",
    "",
    "Structured input is a JSON string or @file pointing at a JSON file. Results are JSON on stdout;",
    `failures print to stderr and exit ${EXIT_FAILURE} (rule violations) or ${EXIT_USAGE} (usage errors).`,
    "",
  ].join("\n");
}

export async function runCli(argv: string[], streams: CliStreams): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    if (parsed.help) {
      streams.stdout(usage());
      return EXIT_OK;
    }
    if (parsed.command === undefined) throw new UsageError(`a command is required\n\n${usage()}`);

    const spec = COMMANDS[parsed.command];
    if (!spec) throw new UsageError(`unknown command: ${parsed.command}\n\n${usage()}`);

    for (const name of parsed.options.keys()) {
      if (name === "root") continue;
      if (!spec.options.includes(name)) throw new UsageError(`unknown option --${name} for \`tasty ${parsed.command}\``);
    }

    const expected = spec.session ? 1 : 0;
    if (parsed.positionals.length < expected) throw new UsageError(`${spec.usage} requires <session-id>`);
    const extra = parsed.positionals[expected];
    if (extra !== undefined) throw new UsageError(`unexpected argument: ${extra}`);

    const rootDir = path.resolve(streams.cwd, parsed.options.get("root") ?? ".");
    const result = await spec.run({
      service: new TastyService(rootDir),
      sessionId: parsed.positionals[0] ?? "",
      options: parsed.options,
      cwd: streams.cwd,
    });
    streams.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return EXIT_OK;
  } catch (error) {
    streams.stderr(`tasty: ${message(error)}\n`);
    return error instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE;
  }
}

/** `import.meta.url` is already resolved, so argv[1] must be too before comparing (e.g. macOS /var → /private/var). */
function invokedDirectly(entry: string | undefined): boolean {
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly(process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (chunk) => void process.stdout.write(chunk),
    stderr: (chunk) => void process.stderr.write(chunk),
  });
}
