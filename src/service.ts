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
import type { LockOptions } from "./lock.js";
import { FileSessionStore } from "./storage.js";
import type { Candidate, ChoiceType, Clock, IdSource, PlanItem, ProfileSynthesis, Reference, TasteSession } from "./types.js";

export class TastyService {
  readonly store: FileSessionStore;

  constructor(
    readonly rootDir: string,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdSource = randomIds,
    lockOptions: LockOptions = {},
  ) {
    this.store = new FileSessionStore(rootDir, lockOptions);
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
    return this.store.mutate(sessionId, (session) => presentComparison(session, input, this.clock, this.ids));
  }

  async choose(sessionId: string, input: { choice: ChoiceType; reason?: string; resolution?: string }): Promise<TasteSession> {
    return this.store.mutate(sessionId, (session) => recordChoice(session, input, this.clock));
  }

  async revise(sessionId: string, input: { estimatedRounds: number; reason: string; items: PlanItem[] }): Promise<TasteSession> {
    return this.store.mutate(sessionId, (session) => revisePlan(session, input, this.clock));
  }

  async complete(sessionId: string): Promise<TasteSession> {
    return this.store.mutate(sessionId, (session) => completeSession(session, this.clock));
  }

  async status(sessionId: string): Promise<{ session: TasteSession; progress: ReturnType<typeof progress> }> {
    const session = await this.store.load(sessionId);
    return { session, progress: progress(session) };
  }

  resume(sessionId: string): Promise<TasteSession> {
    return this.store.load(sessionId);
  }

  /**
   * Publication and the event recording it share one lock, so no other writer interleaves between them
   * and the event always follows the version it records. The pair is ordered, not transactional: a crash
   * in between leaves a published version whose event was never appended.
   */
  async compile(sessionId: string, synthesis?: ProfileSynthesis): Promise<CompiledProfile> {
    return this.store.withSessionLock(sessionId, async () => {
      const session = await this.store.load(sessionId);
      if (session.status !== "complete") throw new Error("session must be complete before compiling");
      const compiled = await compileProfile(this.rootDir, session, this.clock.now(), synthesis);
      await this.store.append(sessionId, compiled.event);
      return compiled;
    });
  }

  async apply(sessionId: string, version?: number): Promise<AppliedProfile> {
    const session = await this.store.load(sessionId);
    return loadCompiledProfile(this.rootDir, session, version);
  }

  profilePath(relativePath: string): string {
    return path.resolve(this.rootDir, relativePath);
  }
}
