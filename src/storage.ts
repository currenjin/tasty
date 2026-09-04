import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent, TasteSession } from "./types.js";
import { reduceEvents } from "./core.js";

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
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await appendFile(this.eventPath(session.id), events.map((event) => `${JSON.stringify(event)}\n`).join(""), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return session;
  }

  async append(sessionId: string, event: SessionEvent): Promise<TasteSession> {
    const current = await this.load(sessionId);
    if (event.at < current.updatedAt) throw new Error("event timestamp cannot go backwards");
    await appendFile(this.eventPath(sessionId), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    return this.load(sessionId);
  }

  async load(sessionId: string): Promise<TasteSession> {
    const raw = await readFile(this.eventPath(sessionId), "utf8");
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
    const raw = await readFile(this.eventPath(sessionId), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as SessionEvent);
  }

  async list(): Promise<string[]> {
    try {
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
