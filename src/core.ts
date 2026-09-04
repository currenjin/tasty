import type {
  Candidate,
  ChoiceType,
  Clock,
  Comparison,
  Decision,
  IdSource,
  PlanItem,
  Reference,
  SessionEvent,
  TasteSession,
} from "./types.js";

export const systemClock: Clock = { now: () => new Date().toISOString() };
export const randomIds: IdSource = {
  next: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
};

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty`);
}

function assertEstimate(value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error("estimatedRounds must be a positive integer");
}

function assertPlanMatchesEstimate(estimatedRounds: number, plan: PlanItem[]): void {
  if (estimatedRounds !== plan.length) throw new Error("estimatedRounds must match plan length");
}

function validatePlan(estimatedRounds: number, plan: PlanItem[]): void {
  assertEstimate(estimatedRounds);
  if (plan.length === 0) throw new Error("plan must contain at least one purpose");
  assertPlanMatchesEstimate(estimatedRounds, plan);
  const unique = new Set<string>();
  let detailSeen = false;
  for (const item of plan) {
    assertNonEmpty(item.id, "plan item id");
    assertNonEmpty(item.purpose, "plan item purpose");
    if (unique.has(item.id)) throw new Error("plan item ids must be unique");
    unique.add(item.id);
    if (item.scale === "detail") detailSeen = true;
    else if (item.scale === "macro" && detailSeen) throw new Error("macro plan items must precede detail items");
  }
}

function assertActive(session: TasteSession): void {
  if (session.status !== "active") throw new Error("session is complete");
}

function validateRevision(session: TasteSession, estimatedRounds: number, reason: string, items: PlanItem[]): void {
  assertActive(session);
  assertNonEmpty(reason, "revision reason");
  validatePlan(estimatedRounds, items);
  if (estimatedRounds < session.decisions.length) throw new Error("estimate cannot be below completed decisions");
  for (let index = 0; index < session.comparisons.length; index += 1) {
    const previous = session.plan[index];
    const revised = items[index];
    if (!previous || !revised || previous.id !== revised.id || previous.purpose !== revised.purpose || previous.scale !== revised.scale) {
      throw new Error("presented plan items cannot change");
    }
  }
}

function validateCompletion(session: TasteSession): void {
  assertActive(session);
  if (session.comparisons.length !== session.decisions.length) throw new Error("active comparison is unanswered");
  if (session.decisions.length !== session.plan.length) throw new Error("all planned comparisons must be decided");
}

export function startEvents(input: {
  target: string;
  estimatedRounds: number;
  plan: PlanItem[];
  references?: Reference[];
  clock?: Clock;
  ids?: IdSource;
}): SessionEvent[] {
  assertNonEmpty(input.target, "target");
  validatePlan(input.estimatedRounds, input.plan);
  const clock = input.clock ?? systemClock;
  const at = clock.now();
  return [
    { type: "session_started", at, sessionId: (input.ids ?? randomIds).next("tasty"), target: input.target },
    {
      type: "plan_created",
      at,
      estimatedRounds: input.estimatedRounds,
      items: structuredClone(input.plan),
      references: structuredClone(input.references ?? []),
    },
  ];
}

export function reduceEvents(events: SessionEvent[]): TasteSession {
  const started = events[0];
  if (!started || started.type !== "session_started") throw new Error("event log must start with session_started");
  const session: TasteSession = {
    schemaVersion: 1,
    id: started.sessionId,
    target: started.target,
    createdAt: started.at,
    updatedAt: started.at,
    status: "active",
    estimatedRounds: 0,
    plan: [],
    references: [],
    comparisons: [],
    decisions: [],
    revisions: [],
    compiledVersions: [],
  };
  for (const event of events.slice(1)) {
    session.updatedAt = event.at;
    switch (event.type) {
      case "plan_created":
        session.estimatedRounds = event.estimatedRounds;
        session.plan = structuredClone(event.items);
        session.references = structuredClone(event.references);
        break;
      case "comparison_presented":
        session.comparisons.push(structuredClone(event.comparison));
        break;
      case "choice_recorded":
        session.decisions.push(structuredClone(event.decision));
        break;
      case "plan_revised":
        session.revisions.push({
          previousEstimate: event.previousEstimate,
          newEstimate: event.newEstimate,
          reason: event.reason,
          at: event.at,
        });
        session.estimatedRounds = event.newEstimate;
        session.plan = structuredClone(event.items);
        break;
      case "session_completed":
        session.status = "complete";
        break;
      case "profile_compiled":
        session.compiledVersions.push(event.version);
        break;
      default:
        throw new Error(`unknown event type: ${(event as { type: string }).type}`);
    }
  }
  if (!session.estimatedRounds) throw new Error("event log is missing plan_created");
  return session;
}

export function presentComparison(
  session: TasteSession,
  input: { planItemId: string; candidates: [Candidate, Candidate] },
  clock: Clock = systemClock,
  ids: IdSource = randomIds,
): SessionEvent {
  if (session.status !== "active") throw new Error("session is complete");
  if (session.comparisons.length > session.decisions.length) throw new Error("answer the active comparison first");
  const item = session.plan.find((entry) => entry.id === input.planItemId);
  if (!item) throw new Error(`unknown plan item: ${input.planItemId}`);
  const presentedIds = new Set(session.comparisons.map((comparison) => comparison.planItemId));
  const nextItem = session.plan.find((entry) => !presentedIds.has(entry.id));
  if (!nextItem) throw new Error("all planned comparisons have been presented");
  if (item.id !== nextItem.id) throw new Error(`next plan item is ${nextItem.id}`);
  if (session.comparisons.some((comparison) => comparison.planItemId === item.id)) {
    throw new Error(`plan item already presented: ${item.id}`);
  }
  const [a, b] = input.candidates;
  if (a.label !== "A" || b.label !== "B") throw new Error("candidates must be ordered A then B");
  assertNonEmpty(a.text, "candidate A");
  assertNonEmpty(b.text, "candidate B");
  const knownRefs = new Set(session.references.map((reference) => reference.id));
  for (const id of [...(a.referenceIds ?? []), ...(b.referenceIds ?? [])]) {
    if (!knownRefs.has(id)) throw new Error(`unknown reference: ${id}`);
  }
  const at = clock.now();
  const comparison: Comparison = {
    id: ids.next("cmp"),
    planItemId: item.id,
    purpose: item.purpose,
    candidates: structuredClone(input.candidates),
    presentedAt: at,
  };
  return { type: "comparison_presented", at, comparison };
}

export function recordChoice(
  session: TasteSession,
  input: { choice: ChoiceType; reason?: string; resolution?: string },
  clock: Clock = systemClock,
): SessionEvent {
  const active = session.comparisons.at(-1);
  if (!active || session.decisions.some((decision) => decision.comparisonId === active.id)) {
    throw new Error("there is no active comparison");
  }
  if (!(["A", "B", "M", "N", "D"] as const).includes(input.choice)) throw new Error("invalid choice");
  if ((input.choice === "M" || input.choice === "D") && !input.resolution?.trim()) {
    throw new Error(`${input.choice} requires resolution text`);
  }
  const at = clock.now();
  const decision: Decision = {
    comparisonId: active.id,
    choice: input.choice,
    decidedAt: at,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    ...(input.resolution?.trim() ? { resolution: input.resolution.trim() } : {}),
  };
  return { type: "choice_recorded", at, decision };
}

export function revisePlan(
  session: TasteSession,
  input: { estimatedRounds: number; reason: string; items: PlanItem[] },
  clock: Clock = systemClock,
): SessionEvent {
  assertEstimate(input.estimatedRounds);
  assertNonEmpty(input.reason, "revision reason");
  assertPlanMatchesEstimate(input.estimatedRounds, input.items);
  if (input.estimatedRounds < session.decisions.length) throw new Error("estimate cannot be below completed decisions");
  const presentedIds = new Set(session.comparisons.map((comparison) => comparison.planItemId));
  if ([...presentedIds].some((id) => !input.items.some((item) => item.id === id))) {
    throw new Error("revised plan cannot remove presented items");
  }
  return {
    type: "plan_revised",
    at: clock.now(),
    previousEstimate: session.estimatedRounds,
    newEstimate: input.estimatedRounds,
    reason: input.reason.trim(),
    items: structuredClone(input.items),
  };
}

export function completeSession(session: TasteSession, clock: Clock = systemClock): SessionEvent {
  if (session.comparisons.length !== session.decisions.length) throw new Error("active comparison is unanswered");
  if (session.decisions.length === 0) throw new Error("cannot complete without a decision");
  return { type: "session_completed", at: clock.now() };
}

export interface Progress {
  completed: number;
  presented: number;
  estimated: number;
  display: string;
  explanation?: string;
}

export function progress(session: TasteSession): Progress {
  const completed = session.decisions.length;
  const hasActive = session.comparisons.length > completed;
  const presented = Math.min(completed + (hasActive ? 1 : 0), session.estimatedRounds);
  const latest = session.revisions.at(-1);
  return {
    completed,
    presented,
    estimated: session.estimatedRounds,
    display: `(${presented}/${session.estimatedRounds} 예정)`,
    ...(latest
      ? { explanation: `예상 질문 수가 ${latest.previousEstimate}개에서 ${latest.newEstimate}개로 변경되었습니다: ${latest.reason}` }
      : {}),
  };
}
