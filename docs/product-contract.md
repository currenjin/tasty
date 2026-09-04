# Tasty Product Contract — Vertical MVP

## Product promise

Tasty helps a person reach an explicit, reusable decision by comparing concrete alternatives. It is a preference elicitation tool, not an autonomous judge and not a research-fact oracle.

The command front door is `/tasty`. Its first visible prompt is exactly:

> 무엇을 결정해볼까요?

It then offers these presets while allowing arbitrary text:

1. 문서/가이드 방향
2. 글쓰기/스타일 규칙
3. 코드/테스트 접근법
4. 프로젝트 컨벤션
5. 디자인/UI 방향
6. 프롬프트/에이전트 응답

The target is preserved verbatim, including meaningful spacing and non-ASCII text.

## Interaction contract

1. **Start:** estimate complexity and create a decision map. Map entries contain question purpose and scale (`macro` or `detail`), not prewritten candidates.
2. **Ask adaptively:** generate one A/B pair just in time from the target and prior decisions. Begin with macro direction and narrow toward details.
3. **Choose:** accept `A`, `B`, `M` (hybrid), `N` (neither), or `D` (the user's direct decision). A reason is optional. M and D require resolution text so the durable preference is unambiguous.
4. **Adapt transparently:** a plan revision records the old estimate, new estimate, full replacement decision map, timestamp, and non-empty reason. Presented map entries cannot disappear. Status surfaces the latest change, e.g. `예상 질문 수가 8개에서 11개로 변경되었습니다: …`.
5. **Finish and compile:** after all planned comparisons are answered, synthesize confirmed rules, anti-rules, contextual rules, unresolved items, and decision boundaries. Every rule must cite a recorded comparison. Every compile allocates a fresh version and cannot silently overwrite an existing directory.
6. **Apply:** load the latest or an explicitly requested immutable profile as prompt-ready context. Confirmed rules and boundaries are applied; unresolved items remain unresolved.

Progress is intentionally an estimate, shown as `(3/11 예정)`. The numerator is the current presented round (or answered count when no question is active); the denominator is the current estimate. It is not a fabricated certainty.

## Reference and provenance policy

A reference is tagged as either:

- **evidence** — material offered in support of an external claim; or
- **inspiration** — material used to suggest a candidate or interaction direction.

Candidates may cite references by ID. The compiler includes only used references and explicitly states that references informed/inspired candidates. A user's selection is stored as a preference. It does not convert a paper's statement into a user preference, nor convert a preference into a research fact. The MVP does not fetch, verify, quote, or summarize sources automatically.

## Persistence and artifacts

The canonical session record is append-only JSON Lines:

```text
.tasty/sessions/<id>/events.jsonl
```

Events cover session start, initial plan, comparison presentation, choice, plan revision, completion, and profile compilation. State is rebuilt by fail-closed replay, and a candidate transition is validated before it is appended. Session data is gitignored and created private by default.

The MVP assumes a trusted local workspace and one Tasty writer per session. Final file components are opened with no-follow semantics, and ancestor components are checked before I/O. A hostile process that can replace workspace directories between those checks is outside the MVP threat model. Cross-process locking, directory-handle-relative I/O, event signatures, atomic directory publication, and fsync durability are future work.

Compiled profiles live at:

```text
profiles/<target-slug>/v0001/
  TASTE.md
  taste.yaml
  decision-receipt.md
```

`TASTE.md` is the readable profile, `taste.yaml` is the machine-readable equivalent, and `decision-receipt.md` records decisions and denominator revisions. The readable and machine profiles separate confirmed rules, anti-rules, contextual rules, unresolved items, and decision boundaries. Synthesized rules must cite decided comparison IDs in the source session; accepting rules cannot be inferred from a `neither` decision. On apply, the loader validates the schema, session, target, version, preferences, references, and synthesis, then requires `TASTE.md` to exactly match the deterministic machine-profile rendering. Profile versions are immutable by convention and protected by exclusive file creation/new version directories. Profiles are intentionally eligible for explicit commits.

## Realistic walkthrough

**User:** `/tasty 팀 API 가이드의 방향`

**Tasty:** `무엇을 결정해볼까요?` (the supplied free text is accepted without forcing a restatement). Tasty estimates 4 rounds and plans purposes: overall organization, example role, tone, and reference depth. It displays `(0/4 예정)`.

For “overall organization,” the agent generates at that moment:

- **A:** task-first recipes with links to reference pages
- **B:** concept-first chapters followed by a complete reference
- **M:** combine them (user supplies how)
- **N:** neither
- **D:** state a different direction directly

The user chooses A because new contributors usually arrive with a concrete task. That reason is optional metadata, not a universal factual claim. Based on the answer, the agent realizes runnable examples and error examples need separate treatment. It calls the revision operation with estimate 5 and a reason. Tasty reports:

> 예상 질문 수가 4개에서 5개로 변경되었습니다: runnable examples and failure examples need separate decisions

After subsequent choices, the user completes the session and compiles `profiles/팀-api-가이드의-방향/v0001/`. Running compile again creates `v0002/`; it does not mutate `v0001/`. A later OpenCode process can reload the session ID and reconstruct the same state from events.

## Academic inspiration (scoped)

These papers motivate design exploration; this MVP does **not** claim to reproduce their algorithms or experimental results:

- **Cieran** — [arXiv:2402.15997](https://arxiv.org/abs/2402.15997). Inspiration for preference-oriented interaction through comparisons.
- **FARPLS** — [arXiv:2403.06267](https://arxiv.org/abs/2403.06267). Inspiration for thinking about pairwise-comparison support and interaction design.
- **Active Preference Learning using Maximum Regret** — [arXiv:2005.04067](https://arxiv.org/abs/2005.04067). Inspiration for asking informative preference questions adaptively.

No maximum-regret optimizer, confidence model, or paper-specific ranking algorithm is implemented. “Adaptive” in this MVP means the agent can revise future question purposes and generate the next pair from persisted prior choices, while the core audits that change.

## Deliberate non-goals

- model-tier routing or provider selection
- evolutionary loops
- multi-agent orchestration
- a heavyweight interview engine
- automated web research or source verification
- probabilistic preference inference
- concurrent writers, remote synchronization, encryption, or access-control management
- automatic git commits or publishing
