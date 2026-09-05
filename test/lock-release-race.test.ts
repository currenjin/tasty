import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whether a duplicate release lands inside the dangerous window is a matter of scheduling, so this
 * file gates `unlink` rather than racing real timings: a stress loop that only sometimes reaches the
 * window would report the bug as fixed whenever it missed. The gate reproduces the exact ordering the
 * bug needs — a second unlink that already passed its token check and then resumes after the path has
 * been handed to a successor.
 *
 * The mock lives in its own file because `vi.mock` applies to the whole module graph. Everything except
 * `unlink` is the real implementation, and `unlink` only pauses for the one path under test.
 */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const gate: { path: string | undefined; unlinked: string[]; first: Deferred; resume: Deferred } = {
  path: undefined,
  unlinked: [],
  first: deferred(),
  resume: deferred(),
};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (file: Parameters<typeof actual.unlink>[0]): Promise<void> => {
      if (String(file) !== gate.path) return actual.unlink(file);
      gate.unlinked.push(String(file));
      if (gate.unlinked.length > 1) await gate.resume.promise;
      await actual.unlink(file);
      gate.first.resolve();
    },
  };
});

const { acquireLock } = await import("../src/lock.js");

let directory: string;
let lockPath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "tasty-lock-race-"));
  lockPath = path.join(directory, "session.lock");
  gate.path = lockPath;
  gate.unlinked = [];
  gate.first = deferred();
  gate.resume = deferred();
});

afterEach(() => {
  // Never leave a gated unlink parked, whatever the assertions did.
  gate.resume.resolve();
  gate.path = undefined;
});

/** Stands in for the next writer taking the path the moment the first release frees it. */
async function acquireSuccessor(): Promise<string> {
  const token = "successor-token";
  await writeFile(lockPath, JSON.stringify({ token, pid: process.pid, host: hostname() }), {
    encoding: "utf8",
    mode: 0o600,
  });
  return token;
}

describe("duplicate release against a successor's acquisition", () => {
  it("runs one unlink, so a successor that acquired mid-release keeps its lock", async () => {
    const handle = await acquireLock(lockPath);

    // Both calls are issued while the lock is still ours, which is what let two token checks pass.
    const releases = [handle.release(), handle.release()];
    await gate.first.promise;
    const successor = await acquireSuccessor();
    gate.resume.resolve();
    await Promise.all(releases);

    expect(gate.unlinked).toHaveLength(1);
    expect(JSON.parse(await readFile(lockPath, "utf8")).token).toBe(successor);
  });

  it("reuses the in-flight release rather than starting a second one", async () => {
    const handle = await acquireLock(lockPath);

    const first = handle.release();
    const second = handle.release();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(gate.unlinked).toHaveLength(1);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
