export type ChoiceType = "A" | "B" | "M" | "N" | "D";
export type ReferenceRole = "evidence" | "inspiration";
export type SessionStatus = "active" | "complete";

export interface Reference {
  id: string;
  title: string;
  url?: string;
  role: ReferenceRole;
  note?: string;
}

export interface PlanItem {
  id: string;
  purpose: string;
  scale: "macro" | "detail";
}

export interface Candidate {
  label: "A" | "B";
  text: string;
  referenceIds?: string[];
}

export interface Comparison {
  id: string;
  planItemId: string;
  purpose: string;
  candidates: [Candidate, Candidate];
  presentedAt: string;
}

export interface Decision {
  comparisonId: string;
  choice: ChoiceType;
  reason?: string;
  resolution?: string;
  decidedAt: string;
}

export interface PlanRevision {
  previousEstimate: number;
  newEstimate: number;
  reason: string;
  at: string;
}

export interface TasteSession {
  schemaVersion: 1;
  id: string;
  target: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  estimatedRounds: number;
  plan: PlanItem[];
  references: Reference[];
  comparisons: Comparison[];
  decisions: Decision[];
  revisions: PlanRevision[];
  compiledVersions: number[];
}

export type SessionEvent =
  | { type: "session_started"; at: string; sessionId: string; target: string }
  | { type: "plan_created"; at: string; estimatedRounds: number; items: PlanItem[]; references: Reference[] }
  | { type: "comparison_presented"; at: string; comparison: Comparison }
  | { type: "choice_recorded"; at: string; decision: Decision }
  | { type: "plan_revised"; at: string; previousEstimate: number; newEstimate: number; reason: string; items: PlanItem[] }
  | { type: "session_completed"; at: string }
  | { type: "profile_compiled"; at: string; version: number; path: string };

export interface Clock {
  now(): string;
}

export interface IdSource {
  next(prefix: string): string;
}
