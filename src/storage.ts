import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent, TasteSession } from "./types.js";
import { reduceEvents } from "./core.js";
import { appendUtf8NoFollow, assertNoSymbolicLinks, readUtf8NoFollow, writeUtf8ExclusiveNoFollow } from "./filesystem.js";
import { acquireLock, type LockOptions } from "./lock.js";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export class FileSessionStore {
  readonly sessionsDir: string;

  constructor(
    readonly rootDir: string,
    private readonly lockOptions: LockOptions = {},
  ) {
    this.sessionsDir = path.join(rootDir, ".tasty", "sessions");
  }

  private eventPath(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) throw new Error("invalid session id");
    return path.join(this.sessionsDir, sessionId, "events.jsonl");
  }

  private lockPath(sessionId: string): string {
    return path.join(path.dirname(this.eventPath(sessionId)), "session.lock");
  }

  async create(events: SessionEvent[]): Promise<TasteSession> {
    const session = reduceEvents(events);
    const directory = path.dirname(this.eventPath(session.id));
    await assertNoSymbolicLinks(this.rootDir, this.sessionsDir);
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    await assertNoSymbolicLinks(this.rootDir, this.sessionsDir);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await assertNoSymbolicLinks(this.rootDir, directory);
    await writeUtf8ExclusiveNoFollow(
      this.eventPath(session.id),
      events.map((event) => `${JSON.stringify(event)}\n`).join(""),
    );
    return session;
  }

  /**
   * The per-session exclusive boundary. Everything that turns observed state into a new event — the
   * load, the transition validation, the append, and for compilation the artifact publication —
   * happens while this process holds the lock, so a concurrent writer can neither read state that is
   * about to change nor append an event that replay would reject.
   */
  async withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPath(sessionId);
    await assertNoSymbolicLinks(this.rootDir, lockPath);
    const handle = await acquireLock(lockPath, this.lockOptions).catch((error: unknown) => {
      // The lock lives beside the event log, so a missing directory means a missing session.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`unknown session: ${sessionId}`);
      throw error;
    });
    try {
      return await run();
    } finally {
      await handle.release();
    }
  }

  /** Loads, validates the caller's transition against that state, and appends it under one lock. */
  async mutate(sessionId: string, transition: (session: TasteSession) => SessionEvent): Promise<TasteSession> {
    return this.withSessionLock(sessionId, async () => {
      const session = await this.load(sessionId);
      return this.append(sessionId, transition(session));
    });
  }

  async append(sessionId: string, event: SessionEvent): Promise<TasteSession> {
    await assertNoSymbolicLinks(this.rootDir, this.eventPath(sessionId));
    const existing = await this.events(sessionId);
    const next = reduceEvents([...existing, event]);
    await appendUtf8NoFollow(this.eventPath(sessionId), `${JSON.stringify(event)}\n`);
    return next;
  }

  async load(sessionId: string): Promise<TasteSession> {
    await assertNoSymbolicLinks(this.rootDir, this.eventPath(sessionId));
    const raw = await readUtf8NoFollow(this.eventPath(sessionId));
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line) as SessionEvent;
        } catch (error) {
          throw new Error(`invalid event JSON at line ${index + 1}`, { cause: error });
        }
      });
    return reduceEvents(events);
  }

  async events(sessionId: string): Promise<SessionEvent[]> {
    await assertNoSymbolicLinks(this.rootDir, this.eventPath(sessionId));
    const raw = await readUtf8NoFollow(this.eventPath(sessionId));
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionEvent);
  }

  async list(): Promise<string[]> {
    try {
      await assertNoSymbolicLinks(this.rootDir, this.sessionsDir);
      return (await readdir(this.sessionsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
