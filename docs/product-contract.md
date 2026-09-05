# Tasty Product Contract — Vertical MVP

## Product promise

Tasty helps a person reach an explicit, reusable decision by comparing concrete alternatives. It is a preference elicitation tool, not an autonomous judge and not a research-fact oracle. It is an independent product; a conversational host such as OpenCode is one optional way to drive it.

## Front doors

Every front door drives the same host-neutral core (`src/core.ts`, `src/storage.ts`, `src/compiler.ts`, `src/service.ts`) and therefore the same decision semantics, validation, and artifacts. Adding or removing a front door never changes what a choice means or what is persisted.

1. **Standalone CLI (`src/cli.ts`).** `tasty [--root <path>] <command>` exposes the complete lifecycle: `start`, `present`, `choose`, `revise-plan`, `status`, `resume`, `complete`, `compile`, `apply`. Structured input is a JSON string or `@file`; results are JSON on stdout; failures exit non-zero with stderr text. `--root` selects the workspace and defaults to the current directory. The CLI is explicit rather than conversational: it never routes models, infers preferences, or generates candidates.
2. **Optional OpenCode adapter (`src/adapters/opencode.ts`).** Nine custom tools — `tasty_start`, `tasty_present`, `tasty_choose`, `tasty_revise_plan`, `tasty_status`, `tasty_resume`, `tasty_complete`, `tasty_compile`, `tasty_apply` — resolving the workspace from each call's `context.directory`. It is exported only from the optional `./adapters/opencode` subpath (`./plugin` is a compatibility re-export), and `@opencode-ai/plugin` is never a production dependency of the core or CLI.

The conversational front door of the OpenCode adapter is `/tasty`. Its first visible prompt is exactly:

> 무엇을 결정해볼까요?

It then offers these presets while allowing arbitrary text:

1. 문서/가이드 방향
2. 글쓰기/스타일 규칙
3. 코드/테스트 접근법
4. 프로젝트 컨벤션
5. 디자인/UI 방향
6. 프롬프트/에이전트 응답

The target is preserved verbatim, including meaningful spacing and non-ASCII text. This holds for every front door: a target supplied to `tasty start` in JSON is stored exactly as written.

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

Concurrent Tasty writers on one machine are serialized rather than forbidden. Every mutation holds an exclusive per-session lock across the whole read-decide-write sequence — load, transition validation, event append, and, for compilation, profile publication plus the event that records it:

```text
.tasty/sessions/<id>/session.lock
```

The lock is a file created with atomic exclusive, no-follow creation and carries its owner (process id, host, timestamp, and a token identifying that one acquisition). Waiting is bounded: a writer that cannot acquire the lock fails rather than proceeding, and a release removes the file only while it still carries that writer's token. Releasing is a single operation per acquisition — repeated or concurrent releases of one lock share it rather than each running their own check-and-remove, so no release can pass its token check and then remove a lock a successor took in the meantime. Releasing is the acquiring writer's own act: there is no callable primitive that removes a lock by path and token. A held lock is reclaimed only when it records an owner whose host is this host and whose process is provably gone; that check and the removal run under a second exclusive guard file, so a live writer's lock is never taken. A recycled process id can only cause a refusal to reclaim, never a wrongful one. Reclaim is fail-closed rather than fully self-healing: the guard carries its own owner token, is released only by the acquisition that took it, and is never stolen from another reclaimer on age, because a reclaimer that looks stalled may only be descheduled. On the same reasoning, a lock that cannot be read is never reclaimed at any age — it names no process to probe, and creation itself publishes an empty file for a moment before the metadata write, so age would not distinguish a crash mid-write from a live acquirer paused inside that window. A reclaimer that dies holding the guard, and a lock left unreadable, therefore both persist; subsequent writers time out instead of removing them, and clearing them is a documented manual step. The consequence is that conflicting operations either serialize or fail cleanly, and the log stays replayable.

This is **single-host serialization only**. It is not claimed to hold on network or shared filesystems such as NFS or SMB, where exclusive creation and process-liveness checks are both unreliable.

The MVP otherwise assumes a trusted local workspace. Final file components are opened with no-follow semantics, and ancestor components are checked before I/O. A hostile process that can replace workspace directories between those checks is outside the MVP threat model. Directory-handle-relative I/O, event signatures, atomic directory publication, and fsync durability are future work.

Compiled profiles live at:

```text
profiles/<target-slug>/v0001/
  TASTE.md
  taste.yaml
  decision-receipt.md
```

`TASTE.md` is the readable profile, `taste.yaml` is the machine-readable equivalent, and `decision-receipt.md` records decisions and denominator revisions. The readable and machine profiles separate confirmed rules, anti-rules, contextual rules, unresolved items, and decision boundaries. Synthesized rules must cite decided comparison IDs in the source session; accepting rules cannot be inferred from a `neither` decision. On apply, the loader validates the schema, session, target, version, preferences, references, and synthesis, then requires `TASTE.md` to exactly match the deterministic machine-profile rendering. Profile versions are immutable by convention and protected by exclusive file creation/new version directories. Profiles are intentionally eligible for explicit commits.

## Realistic walkthrough

Shown through the conversational OpenCode adapter. The same sequence is available as explicit `tasty` CLI commands, and produces byte-identical artifacts.

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

After subsequent choices, the user completes the session and compiles `profiles/팀-api-가이드의-방향/v0001/`. Running compile again creates `v0002/`; it does not mutate `v0001/`. Any later Tasty process can reload the session ID and reconstruct the same state from events — the same session started in OpenCode can be resumed with `tasty resume <id>`, and vice versa.

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
- concurrency beyond one host: writers on network or shared filesystems, remote synchronization, encryption, or access-control management
- automatic git commits or publishing
