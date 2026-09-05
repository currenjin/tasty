import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, open, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { beforeEach, describe, expect, it } from "vitest";
import * as lockModule from "../src/lock.js";
import { LockTimeoutError, acquireLock, withFileLock, type LockOwner } from "../src/lock.js";
import * as publicApi from "../src/index.js";

let directory: string;
let lockPath: string;
let guardPath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "tasty-lock-"));
  lockPath = path.join(directory, "session.lock");
  guardPath = `${lockPath}.reclaim`;
});

async function readOwner(): Promise<LockOwner> {
  return JSON.parse(await readFile(lockPath, "utf8")) as LockOwner;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** Plants a lock file that this process did not create, standing in for another process's lock. */
async function plant(owner: Partial<LockOwner>): Promise<LockOwner> {
  const planted: LockOwner = {
    token: "planted-token",
    pid: 424242,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ...owner,
  };
  await writeFile(lockPath, JSON.stringify(planted), { encoding: "utf8", mode: 0o600 });
  return planted;
}

/**
 * Plants a lock whose metadata names no unambiguous owner, and returns the exact bytes written so a
 * test can assert the file was left untouched. `undefined` in `overrides` drops the key entirely.
 */
async function plantNonconforming(overrides: Record<string, unknown>): Promise<string> {
  const raw = JSON.stringify({
    token: "planted-token",
    pid: 424242,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ...overrides,
  });
  await writeFile(lockPath, raw, { encoding: "utf8", mode: 0o600 });
  return raw;
}

/** Plants a reclaim guard that this process did not create, standing in for another reclaimer. */
async function plantGuard(owner: Partial<LockOwner> = {}): Promise<LockOwner> {
  const planted: LockOwner = {
    token: "planted-guard-token",
    pid: 424243,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ...owner,
  };
  await writeFile(guardPath, JSON.stringify(planted), { encoding: "utf8", mode: 0o600 });
  return planted;
}

async function backdate(file: string, ms: number): Promise<void> {
  const aged = new Date(Date.now() - ms);
  await utimes(file, aged, aged);
}

const dead = { isAlive: () => false };
const alive = { isAlive: () => true };

describe("exclusive lock file", () => {
  it("creates the lock with owner metadata and removes it on release", async () => {
    const handle = await acquireLock(lockPath);

    const owner = await readOwner();
    expect(owner).toMatchObject({ pid: process.pid, host: hostname() });
    expect(owner.token).toEqual(handle.owner.token);
    expect(Number.isNaN(Date.parse(owner.acquiredAt))).toBe(false);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);

    await handle.release();
    expect(await exists(lockPath)).toBe(false);
  });

  it("serializes overlapping critical sections that would otherwise interleave", async () => {
    const counter = path.join(directory, "counter");
    await writeFile(counter, "0", "utf8");
    const bump = async (): Promise<void> => {
      const current = Number(await readFile(counter, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 1));
      await writeFile(counter, String(current + 1), "utf8");
    };

    await Promise.all(Array.from({ length: 10 }, () => withFileLock(lockPath, bump)));

    expect(await readFile(counter, "utf8")).toBe("10");
    expect(await exists(lockPath)).toBe(false);
  });

  it("waits for the holder rather than failing immediately", async () => {
    const order: string[] = [];
    // Acquiring up front, rather than racing two `withFileLock` calls, makes the holder a fact
    // before the waiter starts; nothing here depends on which promise the runtime resumes first.
    const held = await acquireLock(lockPath);
    order.push("first-in");

    const second = withFileLock(lockPath, () => {
      order.push("second-in");
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(order).toEqual(["first-in"]);

    order.push("first-out");
    await held.release();
    await second;

    expect(order).toEqual(["first-in", "first-out", "second-in"]);
  });

  it("gives up after the bounded wait and names the blocking owner", async () => {
    const planted = await plant({ pid: process.pid });
    const started = Date.now();

    const attempt = acquireLock(lockPath, { timeoutMs: 120, pollIntervalMs: 10, ...alive });

    await expect(attempt).rejects.toBeInstanceOf(LockTimeoutError);
    await expect(attempt).rejects.toThrow(new RegExp(`${planted.pid}`));
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await exists(lockPath)).toBe(true);
  });

  it("reclaims a lock whose owner process on this host is gone", async () => {
    await plant({ pid: 424242 });

    const handle = await acquireLock(lockPath, { timeoutMs: 500, pollIntervalMs: 5, ...dead });

    expect((await readOwner()).pid).toBe(process.pid);
    await handle.release();
  });

  it("never reclaims a lock whose owner process is still running", async () => {
    await plant({ pid: process.pid });

    await expect(acquireLock(lockPath, { timeoutMs: 80, pollIntervalMs: 5, ...alive })).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    expect((await readOwner()).token).toBe("planted-token");
  });

  it("never reclaims a lock recorded against a different host", async () => {
    await plant({ host: `${hostname()}-elsewhere` });

    await expect(acquireLock(lockPath, { timeoutMs: 80, pollIntervalMs: 5, ...dead })).rejects.toThrow(
      /different host|another host/i,
    );
    expect((await readOwner()).token).toBe("planted-token");
  });

  it("never reclaims an unattributable lock, however old, and times out instead", async () => {
    await writeFile(lockPath, "not json", { encoding: "utf8", mode: 0o600 });
    await backdate(lockPath, 3_600_000);

    await expect(acquireLock(lockPath, { timeoutMs: 80, pollIntervalMs: 5, ...dead })).rejects.toBeInstanceOf(
      LockTimeoutError,
    );

    expect(await readFile(lockPath, "utf8")).toBe("not json");
  });

  it("never reclaims an aged empty lock whose creator still holds the descriptor", async () => {
    // Models the window every acquisition passes through: the exclusive create has published an
    // empty file and the acquirer is paused before writing its metadata. Age says nothing about
    // liveness here, so reclaiming on age would unlink a lock that is about to be held for real.
    const creating = await open(lockPath, "wx", 0o600);
    try {
      await backdate(lockPath, 3_600_000);

      await expect(acquireLock(lockPath, { timeoutMs: 80, pollIntervalMs: 5, ...dead })).rejects.toBeInstanceOf(
        LockTimeoutError,
      );

      // The paused acquirer resumes and finishes its write; had the lock been unlinked, this would
      // land on an orphaned inode and leave nothing at `lockPath`.
      await creating.write(JSON.stringify({ token: "mid-write", pid: process.pid, host: hostname() }));
    } finally {
      await creating.close();
    }

    expect((await readOwner()).token).toBe("mid-write");
  });

  /**
   * Each shape overrides exactly one field of otherwise valid metadata, so a failure names the field
   * that was accepted too loosely. None of them attributes the lock to a process this reclaimer could
   * have probed: a lock with no token cannot be unlinked safely, one with no host may belong to another
   * machine, a pid outside the range a real process id can occupy probes as "not running" whatever the
   * platform does with it, and a timestamp that is not the ISO instant an acquisition writes is
   * evidence the file was not produced by an acquisition at all.
   */
  const nonconformingOwners: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["an empty token", { token: "" }],
    ["a missing token", { token: undefined }],
    ["a non-string token", { token: 7 }],
    ["an empty host", { host: "" }],
    ["a missing host", { host: undefined }],
    ["a non-string host", { host: ["elsewhere"] }],
    ["a zero pid", { pid: 0 }],
    ["a negative pid", { pid: -424242 }],
    ["a fractional pid", { pid: 424242.5 }],
    ["a pid beyond the safe integer range", { pid: Number.MAX_SAFE_INTEGER + 2 }],
    ["a non-numeric pid", { pid: "424242" }],
    ["a missing acquiredAt", { acquiredAt: undefined }],
    ["an empty acquiredAt", { acquiredAt: "" }],
    ["an unparseable acquiredAt", { acquiredAt: "whenever" }],
    ["a non-string acquiredAt", { acquiredAt: 1_700_000_000_000 }],
    ["an acquiredAt that is not the instant an acquisition writes", { acquiredAt: "2024-01-01" }],
    ["no fields at all", { token: undefined, pid: undefined, host: undefined, acquiredAt: undefined }],
  ];

  describe.each(nonconformingOwners)("a lock recording %s", (_label, overrides) => {
    it("is never reclaimed, however old, and times out leaving the file byte for byte intact", async () => {
      const raw = await plantNonconforming(overrides);
      await backdate(lockPath, 3_600_000);

      await expect(acquireLock(lockPath, { timeoutMs: 80, pollIntervalMs: 5, ...dead })).rejects.toBeInstanceOf(
        LockTimeoutError,
      );

      expect(await readFile(lockPath, "utf8")).toBe(raw);
      // A guard taken to inspect the lock is still released; only the lock itself survives.
      expect(await exists(guardPath)).toBe(false);
    });
  });

  it("still reclaims a dead owner whose pid sits at the edge of the valid range", async () => {
    await plant({ pid: Number.MAX_SAFE_INTEGER });

    const handle = await acquireLock(lockPath, { timeoutMs: 500, pollIntervalMs: 5, ...dead });

    expect((await readOwner()).pid).toBe(process.pid);
    await handle.release();
  });

  it("releases without deleting a lock that already belongs to a successor", async () => {
    const handle = await acquireLock(lockPath);
    await plant({ token: "successor" });

    await handle.release();

    expect((await readOwner()).token).toBe("successor");
  });

  it("performs one release operation however many times a handle is released", async () => {
    const handle = await acquireLock(lockPath);

    // Duplicate and concurrent calls must share one read-owner → unlink sequence. Two sequences can
    // both observe our token, and the second one's unlink then lands on whatever holds the path by
    // the time it runs — a successor's lock, not ours.
    const concurrent = [handle.release(), handle.release(), handle.release()];
    expect(new Set(concurrent).size).toBe(1);

    await Promise.all(concurrent);
    expect(await exists(lockPath)).toBe(false);
    // A late duplicate reuses the settled operation rather than starting another sequence.
    expect(handle.release()).toBe(concurrent[0]);
  });

  it("keeps the unguarded release primitive out of the module and package surface", () => {
    // `releaseLock(path, token)` was callable concurrently by anyone holding a token, which is exactly
    // the sequence `LockHandle.release` now serializes. Only the handle may release a lock.
    expect(Object.keys(lockModule)).not.toContain("releaseLock");
    expect(Object.keys(publicApi)).not.toContain("releaseLock");
    expect(Object.keys(publicApi)).toContain("acquireLock");
  });

  it("leaves no reclaim guard behind after a reclaim", async () => {
    await plant({ pid: 424242 });

    const handle = await acquireLock(lockPath, { timeoutMs: 500, pollIntervalMs: 5, ...dead });
    await handle.release();

    expect(await exists(guardPath)).toBe(false);
    expect(await exists(lockPath)).toBe(false);
  });

  it("gives the reclaim guard owner metadata identifying this acquisition", async () => {
    await plant({ pid: 424242 });
    let guard: LockOwner | undefined;

    const handle = await acquireLock(lockPath, {
      timeoutMs: 500,
      pollIntervalMs: 5,
      isAlive: () => {
        guard = JSON.parse(readFileSync(guardPath, "utf8")) as LockOwner;
        return false;
      },
    });
    await handle.release();

    expect(guard).toMatchObject({ pid: process.pid, host: hostname() });
    expect(typeof guard?.token).toBe("string");
    expect(guard?.token).not.toHaveLength(0);
    expect(Number.isNaN(Date.parse(guard!.acquiredAt))).toBe(false);
  });

  it("never steals an existing reclaim guard, however old, and times out instead", async () => {
    await plant({ pid: 424242 });
    await plantGuard();
    await backdate(guardPath, 3_600_000);

    await expect(acquireLock(lockPath, { timeoutMs: 120, pollIntervalMs: 5, ...dead })).rejects.toBeInstanceOf(
      LockTimeoutError,
    );

    expect((await readOwner()).token).toBe("planted-token");
    expect(JSON.parse(await readFile(guardPath, "utf8")).token).toBe("planted-guard-token");
  });

  it("leaves a successor's reclaim guard in place when releasing its own", async () => {
    await plant({ pid: 424242 });

    const handle = await acquireLock(lockPath, {
      timeoutMs: 500,
      pollIntervalMs: 5,
      // Stands in for this reclaimer being paused long enough to lose its guard to a successor.
      isAlive: () => {
        writeFileSync(guardPath, JSON.stringify({ token: "successor-guard", pid: 424244, host: hostname() }), {
          encoding: "utf8",
          mode: 0o600,
        });
        return false;
      },
    });
    await handle.release();

    expect(JSON.parse(await readFile(guardPath, "utf8")).token).toBe("successor-guard");
  });

  it("never unlinks a lock that a successor acquired while the reclaimer was paused", async () => {
    await plant({ pid: 424242 });
    let paused = false;

    // The first probe stands in for a pause: the dead owner's lock is replaced by a live successor's.
    const attempt = acquireLock(lockPath, {
      timeoutMs: 120,
      pollIntervalMs: 5,
      isAlive: () => {
        if (paused) return true;
        paused = true;
        writeFileSync(lockPath, JSON.stringify({ token: "successor", pid: process.pid, host: hostname() }), {
          encoding: "utf8",
          mode: 0o600,
        });
        return false;
      },
    });

    await expect(attempt).rejects.toBeInstanceOf(LockTimeoutError);
    expect((await readOwner()).token).toBe("successor");
  });

  it("refuses a lock path that is a symbolic link", async () => {
    await writeFile(path.join(directory, "target"), "", "utf8");
    await symlink(path.join(directory, "target"), lockPath);

    await expect(acquireLock(lockPath, { timeoutMs: 80, pollIntervalMs: 5, ...dead })).rejects.toThrow(
      /ELOOP|symbolic link|timed out/i,
    );
    expect((await stat(path.join(directory, "target"))).size).toBe(0);
  });

  it("releases the lock when the critical section throws", async () => {
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await exists(lockPath)).toBe(false);
  });
});
