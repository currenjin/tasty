import path from "node:path";
import { compileProfile, loadCompiledProfile, type AppliedProfile, type CompiledProfile } from "./compiler.js";
import {
  completeSession,
  presentComparison,
  progress,
  randomIds,
  recordChoice,
  revisePlan,
  startEvents,
  systemClock,
} from "./core.js";
import { FileSessionStore } from "./storage.js";
import type { Candidate, ChoiceType, Clock, IdSource, PlanItem, ProfileSynthesis, Reference, TasteSession } from "./types.js";

export class TastyService {
  readonly store: FileSessionStore;

  constructor(
    readonly rootDir: string,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdSource = randomIds,
  ) {
    this.store = new FileSessionStore(rootDir);
  }

  async start(input: {
    target: string;
    estimatedRounds: number;
    plan: PlanItem[];
    references?: Reference[];
  }): Promise<TasteSession> {
    const events = startEvents({ ...input, clock: this.clock, ids: this.ids });
    return this.store.create(events);
  }

  async present(sessionId: string, input: { planItemId: string; candidates: [Candidate, Candidate] }): Promise<TasteSession> {
    const session = await this.store.load(sessionId);
    return this.store.append(sessionId, presentComparison(session, input, this.clock, this.ids));
  }

  async choose(sessionId: string, input: { choice: ChoiceType; reason?: string; resolution?: string }): Promise<TasteSession> {
    const session = await this.store.load(sessionId);
    return this.store.append(sessionId, recordChoice(session, input, this.clock));
  }

  async revise(sessionId: string, input: { estimatedRounds: number; reason: string; items: PlanItem[] }): Promise<TasteSession> {
    const session = await this.store.load(sessionId);
    return this.store.append(sessionId, revisePlan(session, input, this.clock));
  }

  async complete(sessionId: string): Promise<TasteSession> {
    const session = await this.store.load(sessionId);
    return this.store.append(sessionId, completeSession(session, this.clock));
  }

  async status(sessionId: string): Promise<{ session: TasteSession; progress: ReturnType<typeof progress> }> {
    const session = await this.store.load(sessionId);
    return { session, progress: progress(session) };
  }

  resume(sessionId: string): Promise<TasteSession> {
    return this.store.load(sessionId);
  }

  async compile(sessionId: string, synthesis?: ProfileSynthesis): Promise<CompiledProfile> {
    const session = await this.store.load(sessionId);
    if (session.status !== "complete") throw new Error("session must be complete before compiling");
    const compiled = await compileProfile(this.rootDir, session, this.clock.now(), synthesis);
    await this.store.append(sessionId, compiled.event);
    return compiled;
  }

  async apply(sessionId: string, version?: number): Promise<AppliedProfile> {
    const session = await this.store.load(sessionId);
    return loadCompiledProfile(this.rootDir, session, version);
  }

  profilePath(relativePath: string): string {
    return path.resolve(this.rootDir, relativePath);
  }
}
