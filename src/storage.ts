import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent, TasteSession } from "./types.js";
import { reduceEvents } from "./core.js";
import { appendUtf8NoFollow, assertNoSymbolicLinks, readUtf8NoFollow, writeUtf8ExclusiveNoFollow } from "./filesystem.js";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export class FileSessionStore {
  readonly sessionsDir: string;

  constructor(readonly rootDir: string) {
    this.sessionsDir = path.join(rootDir, ".tasty", "sessions");
  }

  private eventPath(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) throw new Error("invalid session id");
    return path.join(this.sessionsDir, sessionId, "events.jsonl");
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
