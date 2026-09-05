import { tool, type Plugin } from "@opencode-ai/plugin";
import { TastyService } from "../service.js";
import type { Candidate, ChoiceType, PlanItem, ProfileSynthesis, Reference } from "../types.js";

const s = tool.schema;
const planItemSchema = s.object({
  id: s.string().min(1),
  purpose: s.string().min(1),
  scale: s.enum(["macro", "detail"]),
});
const referenceSchema = s.object({
  id: s.string().min(1),
  title: s.string().min(1),
  url: s.string().url().optional(),
  role: s.enum(["evidence", "inspiration"]),
  note: s.string().optional(),
});
const candidateSchema = s.object({
  label: s.enum(["A", "B"]),
  text: s.string().min(1),
  referenceIds: s.array(s.string()).optional(),
});
const evidencedRuleSchema = s.object({
  rule: s.string().min(1),
  evidenceComparisonIds: s.array(s.string().min(1)).min(1),
});
const synthesisSchema = s.object({
  summary: s.string().min(1),
  confirmedRules: s.array(evidencedRuleSchema),
  antiRules: s.array(evidencedRuleSchema),
  contextualRules: s.array(evidencedRuleSchema.extend({ context: s.string().min(1) })),
  unresolved: s.array(s.string().min(1)),
  decisionBoundaries: s.array(s.string().min(1)),
});

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const TastyPlugin: Plugin = async () => ({
  tool: {
    tasty_start: tool({
      description:
        "Start a persisted Tasty decision session after receiving the user's free-form target. Plan purposes from macro to detail, but do not generate A/B candidate prose yet.",
      args: {
        target: s.string().min(1).describe("The user's exact free-form decision target; do not normalize or summarize it"),
        estimatedRounds: s.number().int().positive(),
        plan: s.array(planItemSchema).min(1),
        references: s.array(referenceSchema).optional(),
      },
      async execute(args, context) {
        const service = new TastyService(context.directory);
        const input = {
          target: args.target,
          estimatedRounds: args.estimatedRounds,
          plan: args.plan as PlanItem[],
          ...(args.references ? { references: args.references as Reference[] } : {}),
        };
        const session = await service.start(input);
        return json({ sessionId: session.id, target: session.target, estimatedRounds: session.estimatedRounds });
      },
    }),
    tasty_present: tool({
      description:
        "Generate and persist the next A/B comparison just in time, based on earlier choices. Candidate A must be first and candidate B second.",
      args: {
        sessionId: s.string().min(1),
        planItemId: s.string().min(1),
        candidates: s.tuple([candidateSchema, candidateSchema]),
      },
      async execute(args, context) {
        const service = new TastyService(context.directory);
        const session = await service.present(args.sessionId, {
          planItemId: args.planItemId,
          candidates: args.candidates as [Candidate, Candidate],
        });
        const status = await service.status(session.id);
        return json({ comparison: session.comparisons.at(-1), progress: status.progress });
      },
    }),
    tasty_choose: tool({
      description:
        "Record A, B, M (hybrid), N (neither), or D (direct user decision). M and D require resolution text. A reason is always optional.",
      args: {
        sessionId: s.string().min(1),
        choice: s.enum(["A", "B", "M", "N", "D"]),
        reason: s.string().optional(),
        resolution: s.string().optional(),
      },
      async execute(args, context) {
        const service = new TastyService(context.directory);
        const session = await service.choose(args.sessionId, {
          choice: args.choice as ChoiceType,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
        });
        return json((await service.status(session.id)).progress);
      },
    }),
    tasty_revise_plan: tool({
      description:
        "Replace the remaining decision map and estimated question count. Preserve presented item ids and provide the transparent reason shown to the user.",
      args: {
        sessionId: s.string().min(1),
        estimatedRounds: s.number().int().positive(),
        reason: s.string().min(1),
        plan: s.array(planItemSchema).min(1),
      },
      async execute(args, context) {
        const service = new TastyService(context.directory);
        const session = await service.revise(args.sessionId, {
          estimatedRounds: args.estimatedRounds,
          reason: args.reason,
          items: args.plan as PlanItem[],
        });
        return json((await service.status(session.id)).progress);
      },
    }),
    tasty_status: tool({
      description: "Report resumable Tasty session state, current comparison, and Korean progress display.",
      args: { sessionId: s.string().min(1) },
      async execute(args, context) {
        return json(await new TastyService(context.directory).status(args.sessionId));
      },
    }),
    tasty_resume: tool({
      description: "Reload a Tasty session from its append-only disk event log.",
      args: { sessionId: s.string().min(1) },
      async execute(args, context) {
        return json(await new TastyService(context.directory).resume(args.sessionId));
      },
    }),
    tasty_complete: tool({
      description: "Mark a Tasty session complete after all presented comparisons are answered.",
      args: { sessionId: s.string().min(1) },
      async execute(args, context) {
        return json(await new TastyService(context.directory).complete(args.sessionId));
      },
    }),
    tasty_compile: tool({
      description:
        "Compile recorded choices into an evidenced, immutable Taste Profile. Generalize choices into rules, anti-rules, contextual rules, unresolved items, and decision boundaries without inventing unsupported evidence.",
      args: { sessionId: s.string().min(1), synthesis: synthesisSchema },
      async execute(args, context) {
        return json(await new TastyService(context.directory).compile(args.sessionId, args.synthesis as ProfileSynthesis));
      },
    }),
    tasty_apply: tool({
      description:
        "Load the latest (or requested) immutable Taste Profile as prompt-ready context. Apply confirmed and contextual rules, honor anti-rules and boundaries, and keep unresolved items unresolved.",
      args: { sessionId: s.string().min(1), version: s.number().int().positive().optional() },
      async execute(args, context) {
        return json(await new TastyService(context.directory).apply(args.sessionId, args.version));
      },
    }),
  },
});

export default TastyPlugin;
