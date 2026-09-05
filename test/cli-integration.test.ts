import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
// Replay is the assertion, not the subject: the packed CLI writes the log, the source reducer reads it.
import { reduceEvents } from "../src/core.js";
import type { SessionEvent, TasteSession } from "../src/types.js";
import { importGraph } from "./import-graph.js";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Host integration modules Tasty no longer has; the shipped tree must contain none of them. */
const HOST_INTEGRATION = /plugin|adapter/i;
const isWindows = process.platform === "win32";
/** npm and npm-installed bins are `.cmd` shims on Windows, which Node only spawns through a shell. */
const NPM = isWindows ? "npm.cmd" : "npm";
const BIN_NAME = isWindows ? "tasty.cmd" : "tasty";

/** A clean consumer project holding an `--omit=dev` install of the packed tarball. */
let consumer: string;
/** The installed package directory, i.e. `<consumer>/node_modules/tasty`. */
let installed: string;
/** The executable npm linked for the `tasty` bin. */
let cli: string;
let workspace: string;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function npm(argv: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const args = [...argv, "--loglevel", "error", "--no-audit", "--no-fund"];
  return run(NPM, isWindows ? args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)) : args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    shell: isWindows,
  });
}

/**
 * Keeps the inherited environment — a child needs SystemRoot, TMPDIR and friends to start at all —
 * and overrides only what the test controls: the search path is narrowed to the Node binary so
 * nothing else can be picked up, and the home directory is redirected into the temporary tree.
 */
function childEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }
  env[isWindows ? "Path" : "PATH"] = path.dirname(process.execPath);
  env.HOME = cwd;
  if (isWindows) env.USERPROFILE = cwd;
  return env;
}

async function isolated(command: string, argv: string[], cwd: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(command, argv, { cwd, env: childEnv(cwd) });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/**
 * Executes the installed `tasty` bin, so npm's bin link is exercised. On POSIX that runs the symlink
 * itself through the shebang; on Windows npm writes a `.cmd` shim that Node refuses to spawn
 * directly, so the shim's existence is asserted separately and its target is run with Node.
 */
async function tasty(...argv: string[]): Promise<CliResult> {
  return isWindows
    ? isolated(process.execPath, [path.join(installed, "dist", "src", "cli.js"), ...argv], workspace)
    : isolated(cli, argv, workspace);
}

/** Runs an ES module inside the consumer project, where only the packed package and its production deps exist. */
async function inConsumer(name: string, source: string, argv: string[] = []): Promise<CliResult> {
  const file = path.join(consumer, name);
  await writeFile(file, source, "utf8");
  return isolated(process.execPath, [file, ...argv], consumer);
}

function json<T>(result: CliResult): T {
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as T;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function manifest(): Promise<{
  bin: Record<string, string>;
  exports: Record<string, { types: string; default: string }>;
  dependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}> {
  return JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
}

/** Every file the tarball actually shipped, as installed, relative to the package root. */
async function shipped(): Promise<string[]> {
  const entries = await readdir(installed, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(installed, path.join(entry.parentPath, entry.name)))
    .sort();
}

beforeAll(async () => {
  // `npm pack` runs the prepare script, so the tarball always carries a freshly built dist/.
  const packDirectory = await mkdtemp(path.join(tmpdir(), "tasty-pack-"));
  await npm(["pack", "--pack-destination", packDirectory], repoRoot);
  const [tarball] = await readdir(packDirectory);
  expect(tarball).toMatch(/\.tgz$/);

  consumer = await realpath(await mkdtemp(path.join(tmpdir(), "tasty-consumer-")));
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({
      name: "tasty-consumer",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: { tasty: `file:${path.join(packDirectory, tarball!)}` },
    }),
    "utf8",
  );
  await npm(["install", "--omit=dev", "--prefer-offline"], consumer);

  installed = path.join(consumer, "node_modules", "tasty");
  cli = path.join(consumer, "node_modules", ".bin", BIN_NAME);
  // Resolved so reported absolute paths compare equal on platforms where the temp root is a symlink.
  workspace = await realpath(await mkdtemp(path.join(tmpdir(), "tasty-standalone-workspace-")));
}, 300_000);

const TARGET = "  우리 팀의 README 방향을 정하고 싶어요 ✨  ";

describe("packed standalone install", () => {
  it("installs into a --omit=dev consumer with the production dependency as its whole tree", async () => {
    const modules = (await readdir(path.join(consumer, "node_modules"))).filter((entry) => !entry.startsWith("."));
    const pkg = await manifest();

    expect(modules.sort()).toEqual(["tasty", "yaml"]);
    expect(pkg.dependencies).toEqual({ yaml: expect.any(String) });
    expect(pkg.peerDependencies ?? {}).toEqual({});
    expect(pkg.peerDependenciesMeta ?? {}).toEqual({});
  });

  it("ships every declared export target as a real file with type declarations", async () => {
    const pkg = await manifest();

    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./cli", "./package.json"]);
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (subpath === "./package.json") continue;
      expect(await exists(path.join(installed, target.default)), `${subpath} default`).toBe(true);
      expect(await exists(path.join(installed, target.types)), `${subpath} types`).toBe(true);
    }
    expect(path.resolve(installed, pkg.bin.tasty!)).toBe(path.join(installed, "dist", "src", "cli.js"));
  });

  it("ships only the built core and CLI, with no host integration module in the tarball", async () => {
    const files = await shipped();

    expect(files).toContain(path.join("dist", "src", "index.js"));
    expect(files).toContain(path.join("dist", "src", "cli.js"));
    expect(files.filter((file) => HOST_INTEGRATION.test(file))).toEqual([]);
    // npm always ships the manifest and the readme; `files` governs everything else.
    const ALWAYS_PACKED = new Set(["package.json", "README.md"]);
    expect(files.filter((file) => !ALWAYS_PACKED.has(file) && !file.startsWith(`dist${path.sep}src${path.sep}`))).toEqual([]);
  });

  it("imports tasty and tasty/cli from the installed consumer and runs the library entry point", async () => {
    const probe = await inConsumer(
      "entrypoints.mjs",
      [
        'import { TastyService, progress } from "tasty";',
        'import { runCli, EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "tasty/cli";',
        "const out = [];",
        'const code = await runCli(["--help"], { cwd: process.cwd(), stdout: (c) => out.push(c), stderr: (c) => out.push(c) });',
        "process.stdout.write(JSON.stringify({",
        "  service: typeof TastyService, progress: typeof progress, runCli: typeof runCli,",
        "  exits: [EXIT_OK, EXIT_FAILURE, EXIT_USAGE], code, help: out.join(``),",
        '  core: import.meta.resolve("tasty"), cli: import.meta.resolve("tasty/cli"),',
        "}));",
      ].join("\n"),
    );

    const result = json<{
      service: string;
      progress: string;
      runCli: string;
      exits: number[];
      code: number;
      help: string;
      core: string;
      cli: string;
    }>(probe);
    expect(result).toMatchObject({ service: "function", progress: "function", runCli: "function", exits: [0, 1, 2], code: 0 });
    expect(result.help).toContain("tasty [--root <path>] <command>");
    expect(fileURLToPath(result.core)).toBe(path.join(installed, "dist", "src", "index.js"));
    expect(fileURLToPath(result.cli)).toBe(path.join(installed, "dist", "src", "cli.js"));
  });

  it("reaches only Node built-ins and yaml from the installed core and CLI runtime import graph", async () => {
    for (const entry of ["dist/src/index.js", "dist/src/cli.js"]) {
      const graph = await importGraph(installed, entry);
      expect(graph.packages.every((name) => name.startsWith("node:") || name === "yaml"), entry).toBe(true);
      expect(graph.files.filter((file) => HOST_INTEGRATION.test(file)), entry).toEqual([]);
    }
  });

  it("exposes no host integration subpath a consumer could import", async () => {
    const attempt = await inConsumer("host-subpath.mjs", 'await import("tasty/plugin");');

    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });
});

describe("standalone CLI subprocess", () => {
  it("runs the linked executable through the bin npm installed for it", async () => {
    expect((await readFile(path.join(installed, "dist", "src", "cli.js"), "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(await exists(cli), `npm should link ${BIN_NAME}`).toBe(true);

    const result = await tasty("--help");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("tasty [--root <path>] <command>");
  });

  it("drives start through apply in a temporary workspace with no host beyond the CLI itself", async () => {
    const started = json<{ sessionId: string; target: string }>(
      await tasty(
        "start",
        "--input",
        JSON.stringify({
          target: TARGET,
          estimatedRounds: 1,
          plan: [{ id: "direction", purpose: "Choose the overall documentation direction", scale: "macro" }],
          references: [{ id: "cieran", title: "Cieran", url: "https://arxiv.org/abs/2402.15997", role: "inspiration" }],
        }),
      ),
    );
    expect(started.target).toBe(TARGET);

    const presented = json<{ comparison: { id: string }; progress: { display: string } }>(
      await tasty(
        "present",
        started.sessionId,
        "--input",
        JSON.stringify({
          planItemId: "direction",
          candidates: [
            { label: "A", text: "Task-first guide", referenceIds: ["cieran"] },
            { label: "B", text: "Concept-first reference" },
          ],
        }),
      ),
    );
    expect(presented.progress.display).toBe("(1/1 예정)");

    json(await tasty("choose", started.sessionId, "--choice", "A", "--reason", "Readers arrive with a task"));

    const status = json<{ session: { target: string }; progress: { completed: number } }>(
      await tasty("status", started.sessionId),
    );
    expect(status.session.target).toBe(TARGET);
    expect(status.progress.completed).toBe(1);

    json(await tasty("resume", started.sessionId));
    json(await tasty("complete", started.sessionId));

    const compiled = json<{ version: number; directory: string; files: [string, string, string] }>(
      await tasty(
        "compile",
        started.sessionId,
        "--input",
        JSON.stringify({
          summary: "Lead with the task.",
          confirmedRules: [{ rule: "Lead with the first executable action.", evidenceComparisonIds: [presented.comparison.id] }],
          antiRules: [],
          contextualRules: [],
          unresolved: [],
          decisionBoundaries: ["Keep required context."],
        }),
      ),
    );
    expect(compiled.version).toBe(1);
    expect(path.relative(workspace, compiled.directory)).toBe(path.join("profiles", "우리-팀의-readme-방향을-정하고-싶어요", "v0001"));

    const machine = parse(await readFile(compiled.files[1], "utf8")) as { target: string; profile_version: number };
    expect(machine).toMatchObject({ target: TARGET, profile_version: 1 });

    const applied = json<{ version: number; markdown: string }>(await tasty("apply", started.sessionId));
    expect(applied.version).toBe(1);
    expect(applied.markdown).toContain("Lead with the first executable action.");
    expect(applied.markdown).toContain("Keep required context.");
  });

  it("stores sessions under --root instead of the working directory", async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), "tasty-root-"));
    const started = json<{ sessionId: string }>(
      await tasty(
        "--root",
        elsewhere,
        "start",
        "--input",
        JSON.stringify({ target: "API style", estimatedRounds: 1, plan: [{ id: "a", purpose: "Choose", scale: "macro" }] }),
      ),
    );

    await expect(readdir(path.join(elsewhere, ".tasty", "sessions"))).resolves.toEqual([started.sessionId]);
    expect((await tasty("status", started.sessionId)).code).toBe(1);
  });

  it("exits non-zero with stderr text on a rule violation and prints nothing on stdout", async () => {
    const result = await tasty("compile", "tasty_missing");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("tasty:");
  });

  it("exits with the usage code for an unknown command", async () => {
    const result = await tasty("frobnicate");

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command: frobnicate");
  });
});

/**
 * A child that parks on a barrier file before mutating, so several real processes enter the critical
 * section within microseconds of each other instead of being spread out by Node's start-up cost.
 */
const RACER = [
  'import { existsSync, writeFileSync } from "node:fs";',
  'import { TastyService } from "tasty";',
  "const [root, sessionId, barrier, index, operation, payload] = process.argv.slice(2);",
  "const service = new TastyService(root);",
  "writeFileSync(`${barrier}/ready-${index}`, ``);",
  "const spinUntil = Date.now() + 30_000;",
  "while (!existsSync(`${barrier}/go`) && Date.now() < spinUntil) {}",
  "try {",
  "  await service[operation](sessionId, JSON.parse(payload));",
  '  process.stdout.write("ok");',
  "} catch (error) {",
  "  process.stdout.write(`failed: ${error.message}`);",
  "}",
].join("\n");

let raceGroup = 0;

async function race(sessionId: string, operations: { operation: string; payload: unknown }[]): Promise<CliResult[]> {
  const barrier = await mkdtemp(path.join(tmpdir(), "tasty-barrier-"));
  const group = (raceGroup += 1);
  const racers = operations.map((entry, index) =>
    inConsumer(`racer-${group}-${index}.mjs`, RACER, [
      workspace,
      sessionId,
      barrier,
      String(index),
      entry.operation,
      JSON.stringify(entry.payload),
    ]),
  );

  while ((await readdir(barrier)).length < operations.length) await new Promise((resolve) => setTimeout(resolve, 10));
  await writeFile(path.join(barrier, "go"), "", "utf8");

  return Promise.all(racers);
}

function repeat(count: number, operation: string, payload: unknown): { operation: string; payload: unknown }[] {
  return Array.from({ length: count }, () => ({ operation, payload }));
}

/** Replays the raw log the way any later Tasty process would, which is the invariant writers must keep. */
async function replay(sessionId: string): Promise<TasteSession> {
  const raw = await readFile(path.join(workspace, ".tasty", "sessions", sessionId, "events.jsonl"), "utf8");
  return reduceEvents(raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionEvent));
}

async function startRaceSession(rounds: number): Promise<string> {
  const plan = Array.from({ length: rounds }, (_, index) => ({
    id: `item-${index}`,
    purpose: `Choose aspect ${index}`,
    scale: "macro",
  }));
  return json<{ sessionId: string }>(
    await tasty("start", "--input", JSON.stringify({ target: "Concurrency", estimatedRounds: rounds, plan })),
  ).sessionId;
}

const RACE_CANDIDATES = [
  { label: "A", text: "Task-first guide" },
  { label: "B", text: "Concept-first reference" },
];

describe("concurrent Tasty processes on one host", () => {
  it("records one choice when separate processes answer the same comparison at once", async () => {
    const sessionId = await startRaceSession(1);
    json(await tasty("present", sessionId, "--input", JSON.stringify({ planItemId: "item-0", candidates: RACE_CANDIDATES })));

    const results = await race(sessionId, repeat(6, "choose", { choice: "A" }));

    expect(results.filter((result) => result.stdout === "ok")).toHaveLength(1);
    for (const result of results.filter((result) => result.stdout !== "ok")) {
      expect(result.stdout).toContain("no active comparison");
    }
    expect((await replay(sessionId)).decisions).toHaveLength(1);
  }, 60_000);

  it("serializes separate processes revising the estimate so the log still replays", async () => {
    const sessionId = await startRaceSession(2);
    const plan = (rounds: number): unknown[] =>
      Array.from({ length: rounds }, (_, index) => ({ id: `item-${index}`, purpose: `Choose aspect ${index}`, scale: "macro" }));
    // Alternating targets mean every writer must observe the estimate the previous writer left behind.
    const results = await race(
      sessionId,
      Array.from({ length: 6 }, (_, index) => ({
        operation: "revise",
        payload: index % 2 === 0
          ? { estimatedRounds: 3, reason: `widen ${index}`, items: plan(3) }
          : { estimatedRounds: 2, reason: `narrow ${index}`, items: plan(2) },
      })),
    );

    expect(results.map((result) => result.stdout)).toEqual(Array(6).fill("ok"));
    const replayed = await replay(sessionId);
    expect(replayed.revisions).toHaveLength(6);
    expect(replayed.estimatedRounds).toBe(replayed.plan.length);
  }, 60_000);

  // Separate `tasty` launches rarely overlap inside the critical section, since Node start-up dwarfs
  // it. This asserts the user-visible contract of a conflict — one winner, clean failures — while the
  // barrier-synchronised tests above are what actually force the race.
  it("reports a conflict between separate CLI invocations as a clean failure", async () => {
    const sessionId = await startRaceSession(1);
    json(await tasty("present", sessionId, "--input", JSON.stringify({ planItemId: "item-0", candidates: RACE_CANDIDATES })));

    const results = await Promise.all(
      ["A", "B", "M", "N", "D"].map((choice) =>
        tasty("choose", sessionId, "--choice", choice, "--resolution", "Blend both"),
      ),
    );

    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    for (const result of results.filter((result) => result.code !== 0)) {
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("no active comparison");
      expect(result.stdout).toBe("");
    }
    expect((await replay(sessionId)).decisions).toHaveLength(1);
  }, 60_000);

  it("leaves no lock file behind once the writers are done", async () => {
    const sessionId = await startRaceSession(1);
    await race(sessionId, repeat(3, "present", { planItemId: "item-0", candidates: RACE_CANDIDATES }));

    const entries = await readdir(path.join(workspace, ".tasty", "sessions", sessionId));

    expect(entries).toEqual(["events.jsonl"]);
    expect((await replay(sessionId)).comparisons).toHaveLength(1);
  }, 60_000);
});
