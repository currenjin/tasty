# Tasty

Tasty is an OpenCode-oriented decision assistant that learns a user's taste through adaptive pairwise comparisons. This repository contains the first vertical MVP: a thin OpenCode command/plugin adapter over a pure TypeScript state core and a file-based, append-only store.

## What works

- `/tasty` opens with `무엇을 결정해볼까요?`, examples, and free-form input.
- The agent plans question **purposes** from macro direction to detail and estimates the number of rounds.
- The agent creates actual A/B prose just in time; the core validates and persists it.
- Choices are A, B, M (hybrid), N (neither), and D (direct decision). M/D include the user's resolution.
- Status reports `(3/11 예정)`-style progress and explains estimate revisions.
- References retain `evidence` or `inspiration` provenance and are kept distinct from recorded preference.
- Sessions resume from private append-only JSONL logs.
- Compilation turns evidenced choices into confirmed rules, anti-rules, contextual rules, unresolved items, and decision boundaries.
- `tasty_apply` loads the latest (or a requested) immutable profile as prompt-ready context for a new artifact.
- Every compile writes `TASTE.md`, `taste.yaml`, and `decision-receipt.md` to a new `vNNNN` directory. Existing versions are never overwritten.

## Install and check

Requirements: Node.js 22+, npm, and OpenCode 1.18.27 or newer. (Bun is not required by Tasty.)

```sh
npm install
npm run check
```

To run the local MVP without installing OpenCode globally:

```sh
npx opencode-ai .
```

The local OpenCode adapter is at `.opencode/plugins/tasty.ts`, and the slash command is at `.opencode/commands/tasty.md`. Open this repository in OpenCode after installing dependencies, then invoke:

```text
/tasty
```

You can also provide a target immediately, for example `/tasty README의 예제 스타일`. The command instructs the agent to preserve that input exactly.

After a session is compiled, use `/tasty apply <session-id>` to load its latest Taste Profile and ask OpenCode to create or revise an artifact under those rules. The profile keeps unresolved items unresolved rather than silently inventing a choice.

For packaging elsewhere, import the default plugin from `src/plugin.ts` (or the package's `./plugin` export). The implementation follows the current `@opencode-ai/plugin` `Plugin` + `tool(...)` convention and resolves storage from each tool call's `context.directory`.

## Data layout

```text
.tasty/sessions/<session-id>/events.jsonl   # private by default; gitignored
profiles/<target-slug>/v0001/TASTE.md       # intentionally committable
profiles/<target-slug>/v0001/taste.yaml
profiles/<target-slug>/v0001/decision-receipt.md
```

Session directories and event files are created with private permissions where the platform supports POSIX modes. Profiles are not ignored: committing them is an explicit user action. Tasty never invokes `git` itself.

## Core/tool boundary

`src/core.ts` is deterministic state transition and validation logic. `src/storage.ts` owns JSONL persistence, `src/compiler.ts` validates evidenced synthesis and owns immutable output versions, and `src/service.ts` coordinates them. `src/plugin.ts` only translates OpenCode custom-tool calls. Candidate generation and rule synthesis intentionally remain with the active model/agent; the core validates provenance and persistence rather than embedding model routing or interview orchestration.

See [docs/product-contract.md](docs/product-contract.md) for semantics, limitations, and a walkthrough.
