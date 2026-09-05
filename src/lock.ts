import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { hostname } from "node:os";
import process from "node:process";
import { readUtf8NoFollow, writeUtf8ExclusiveNoFollow } from "./filesystem.js";

/**
 * A single-host, cross-process exclusive lock built on `O_CREAT | O_EXCL | O_NOFOLLOW`, which is the
 * atomic create-if-absent primitive local POSIX filesystems provide. It serializes Tasty writers on
 * one machine. It deliberately makes **no** claim about NFS, SMB, or any other network filesystem,
 * where `O_EXCL` create and the process-liveness check below are both unreliable.
 */
export interface LockOwner {
  /** Distinguishes this acquisition from any later one on the same path, so release is idempotent. */
  token: string;
  pid: number;
  host: string;
  acquiredAt: string;
}

export interface LockOptions {
  /** Bounded wait before giving up; the lock never blocks forever. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Injection point for the liveness probe; production uses signal 0. */
  isAlive?(pid: number): boolean;
}

export interface LockHandle {
  owner: LockOwner;
  /**
   * Releases this acquisition, and only this one. Every call — duplicated, concurrent, or long after
   * the first — returns the same promise, so the read-owner → unlink sequence runs at most once per
   * handle. Two sequences could otherwise both observe our token and the later unlink would land on
   * whatever holds the path by the time it resumed, which is a successor's lock. A failed release is
   * not retried: the settled rejection is what every later caller sees.
   */
  release(): Promise<void>;
}

export class LockTimeoutError extends Error {
  constructor(
    message: string,
    readonly lockPath: string,
    readonly owner?: LockOwner,
  ) {
    super(message);
    this.name = "LockTimeoutError";
  }
}

const DEFAULTS = { timeoutMs: 10_000, pollIntervalMs: 20 } as const;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Signal 0 probes existence without delivering anything; EPERM means it exists but is not ours. */
function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOwner(raw: string): LockOwner | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof value.token !== "string" || typeof value.host !== "string" || !Number.isInteger(value.pid)) {
      return undefined;
    }
    return { token: value.token, pid: value.pid!, host: value.host, acquiredAt: String(value.acquiredAt) };
  } catch {
    return undefined;
  }
}

/** Returns the current owner, `undefined` for an unreadable lock, or `null` when the lock is free. */
async function readOwner(lockPath: string): Promise<LockOwner | undefined | null> {
  try {
    return parseOwner(await readUtf8NoFollow(lockPath));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    // A lock path that is a symbolic link (ELOOP) is a tampering signal, not a stale lock.
    throw error;
  }
}

async function removeIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function newOwner(): LockOwner {
  return { token: randomUUID(), pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() };
}

/**
 * Removes `file` only while it still carries `token`. Every file this module creates — the lock and
 * the reclaim guard alike — records the owner of one acquisition, so a holder descheduled arbitrarily
 * long can never unlink a file belonging to a *different* acquisition when it resumes.
 *
 * The token check and the unlink are separate steps, which makes that guarantee conditional on at most
 * one call per token being in flight: two overlapping calls both see the token, and the second unlink
 * then removes whatever took the path after the first one freed it. Nothing here can enforce that, so
 * this stays module-private. Its two callers each satisfy it — `LockHandle.release` runs one shared
 * sequence per acquisition however often it is called, and a reclaim guard is released exactly once,
 * by the reclaimer that created it.
 */
async function releaseOwnedFile(file: string, token: string): Promise<void> {
  const owner = await readOwner(file).catch(() => undefined);
  if (owner?.token !== token) return;
  await removeIfPresent(file);
}

/**
 * Removes a lock whose owner is provably gone, and does so under a second exclusive file so that the
 * read-owner → check-liveness → unlink sequence is serialized against other Tasty reclaimers. A live
 * holder is therefore never unlinked: the file can only disappear via its owner's release (the owner
 * is dead) or via another reclaimer (excluded by the guard).
 *
 * The policy is deliberately conservative. A lock is reclaimed only when it is readable and both its
 * recorded host matches this host and its recorded pid is not running. Anything else waits out the
 * timeout instead. Recycled pids only ever cause a refusal to reclaim, never a wrongful one.
 *
 * A malformed lock — including the empty file every acquisition briefly publishes between its
 * exclusive create and its metadata write — is **never** reclaimed, at any age. Such a file carries
 * no token and no pid, so nothing distinguishes a crash mid-write from an acquirer descheduled inside
 * that window; an old mtime does not imply a dead creator, and unlinking on age would take the lock
 * out from under a live holder that is about to record itself.
 *
 * Three rules keep the whole sequence safe even when this reclaimer is descheduled for an unbounded
 * stretch between any two of its steps: an existing guard is never stolen on age, because a reclaimer
 * that appears stalled may simply be paused and stealing its guard would let two reclaimers unlink
 * concurrently; every unlink is token-checked, so a lock replaced by a live successor while we were
 * paused survives; and a lock with no token is left alone. The residual cost is that a reclaimer which
 * dies holding the guard orphans it, and that a genuinely crashed mid-write lock is never cleared
 * automatically. In both cases later writers time out instead of reclaiming; see `README.md` for the
 * manual cleanup (delete `<session>/session.lock.reclaim`, then `session.lock` if its owner is really
 * gone or it records no owner at all).
 */
async function reclaimIfStale(lockPath: string, options: Required<Pick<LockOptions, "isAlive">>): Promise<boolean> {
  const guardPath = `${lockPath}.reclaim`;
  const guard = newOwner();
  try {
    await writeUtf8ExclusiveNoFollow(guardPath, JSON.stringify(guard));
  } catch (error) {
    // Another reclaimer holds the guard, or a dead one orphaned it. Either way, wait rather than steal.
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    const owner = await readOwner(lockPath);
    if (owner === null) return true;
    // Unreadable: no token, no pid, so no evidence of a dead owner. Fail closed and wait.
    if (owner === undefined) return false;
    if (owner.host !== hostname()) return false;
    if (options.isAlive(owner.pid)) return false;
    await releaseOwnedFile(lockPath, owner.token);
    return true;
  } finally {
    await releaseOwnedFile(guardPath, guard.token);
  }
}

function blockedMessage(lockPath: string, owner: LockOwner | undefined | null, timeoutMs: number): string {
  if (!owner) return `timed out after ${timeoutMs}ms waiting for ${lockPath}`;
  const where = owner.host === hostname() ? `pid ${owner.pid}` : `pid ${owner.pid} on a different host (${owner.host})`;
  return `timed out after ${timeoutMs}ms waiting for ${lockPath}, held by ${where} since ${owner.acquiredAt}`;
}

export async function acquireLock(lockPath: string, options: LockOptions = {}): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const policy = { isAlive: options.isAlive ?? processIsAlive };
  const deadline = Date.now() + timeoutMs;
  let blocker: LockOwner | undefined | null;

  while (true) {
    const owner = newOwner();
    try {
      await writeUtf8ExclusiveNoFollow(lockPath, JSON.stringify(owner));
      let releasing: Promise<void> | undefined;
      return {
        owner,
        release: () => (releasing ??= releaseOwnedFile(lockPath, owner.token)),
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    blocker = await readOwner(lockPath);
    if (await reclaimIfStale(lockPath, policy)) continue;
    if (Date.now() >= deadline) break;
    await delay(Math.max(1, Math.min(pollIntervalMs, deadline - Date.now())));
  }
  throw new LockTimeoutError(blockedMessage(lockPath, blocker, timeoutMs), lockPath, blocker ?? undefined);
}

export async function withFileLock<T>(
  lockPath: string,
  run: (owner: LockOwner) => Promise<T> | T,
  options: LockOptions = {},
): Promise<T> {
  const handle = await acquireLock(lockPath, options);
  try {
    return await run(handle.owner);
  } finally {
    await handle.release();
  }
}
