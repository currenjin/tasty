# Tasty

Tasty is a file-based, adaptive decision assistant that learns a user's taste through pairwise comparisons. It is an independent product: a deterministic TypeScript core, an append-only file store, and a standalone `tasty` CLI. OpenCode is supported as one optional host adapter, not a requirement.

## What works

- The agent (or you) plans question **purposes** from macro direction to detail and estimates the number of rounds.
- Actual A/B prose is created just in time; the core validates and persists it.
- Choices are A, B, M (hybrid), N (neither), and D (direct decision). M/D include the user's resolution.
- Status reports `(3/11 예정)`-style progress and explains estimate revisions.
- References retain `evidence` or `inspiration` provenance and are kept distinct from recorded preference.
- Sessions resume from private append-only JSONL logs.
- Compilation turns evidenced choices into confirmed rules, anti-rules, contextual rules, unresolved items, and decision boundaries.
- `apply` loads the latest (or a requested) immutable profile as prompt-ready context for a new artifact.
- Every compile writes `TASTE.md`, `taste.yaml`, and `decision-receipt.md` to a new `vNNNN` directory. Existing versions are never overwritten.

## Install and check

Requirements: Node.js 22+ and npm. OpenCode is **not** required, and neither is Bun.

### From a source checkout (development)

```sh
npm install     # installs dev dependencies and builds dist/ via the prepare script
npm run check   # typecheck + full test suite
```

Installing the repository into itself does **not** put a `tasty` command on your `PATH` — npm only links
bins for *dependencies*. Invoke the built CLI by path instead, and rebuild after editing `src/`:

```sh
node dist/src/cli.js --help
npm run build
```

### As an installed package (consumer)

Packing and installing the tarball is what links the `tasty` executable (`dist/src/cli.js`):

```sh
npm pack                                    # → tasty-0.1.0.tgz
npm install --global ./tasty-0.1.0.tgz      # `tasty` on PATH
npm install --omit=dev ./tasty-0.1.0.tgz    # `node_modules/.bin/tasty` in a project
```

A production (`--omit=dev`) install pulls in `yaml` only — no OpenCode, no TypeScript toolchain. The
package ships built JavaScript with type declarations, so the library entry points are importable too:

```js
import { TastyService } from "tasty";
import { runCli } from "tasty/cli";
```

## CLI

```text
tasty [--root <path>] <command> [<session-id>] [options]
```

`--root` selects the workspace that holds `.tasty/` and `profiles/`; it defaults to the current directory. Results are JSON on stdout. Failures print to stderr and exit `1` for a rule violation or `2` for a usage error. Run `tasty --help` for the full listing.

Structured input is passed as `--input <json>` or `--input @file.json` (paths resolve against the invocation directory). Text you supply in JSON — most importantly the decision `target` — is preserved exactly, including leading/trailing spacing and non-ASCII characters.

| Command | Input |
| --- | --- |
| `tasty start` | `{ target, estimatedRounds, plan[], references?[] }` |
| `tasty present <id>` | `{ planItemId, candidates: [A, B] }` |
| `tasty choose <id>` | `--choice <A\|B\|M\|N\|D> [--reason <text>] [--resolution <text>]`, or `--input` with `{ choice, reason?, resolution? }` — the two forms cannot be mixed |
| `tasty revise-plan <id>` | `{ estimatedRounds, reason, plan[] }` |
| `tasty status <id>` | — |
| `tasty resume <id>` | — |
| `tasty complete <id>` | — |
| `tasty compile <id>` | optional `{ summary, confirmedRules[], antiRules[], contextualRules[], unresolved[], decisionBoundaries[] }` |
| `tasty apply <id>` | optional `--version <n>` |

A complete session:

```sh
tasty start --input '{
  "target": "우리 팀의 README 방향",
  "estimatedRounds": 1,
  "plan": [{ "id": "direction", "purpose": "Choose the overall direction", "scale": "macro" }]
}'
# → {"sessionId": "tasty_…", …}

tasty present tasty_… --input '{
  "planItemId": "direction",
  "candidates": [
    { "label": "A", "text": "Task-first guide" },
    { "label": "B", "text": "Concept-first reference" }
  ]
}'
tasty choose tasty_… --choice A --reason "Readers arrive with a task"
tasty complete tasty_…
tasty compile tasty_…
tasty apply tasty_…
```

The CLI is deliberately explicit. It does not route models, infer preferences, or generate candidates; you or your agent supply the prose and the synthesis, and the core validates provenance and persistence.

## Optional: OpenCode adapter

The OpenCode integration lives in `src/adapters/opencode.ts` and is exported from the optional `tasty/adapters/opencode` subpath (`tasty/plugin` remains as a compatibility re-export). Both ship as built JavaScript, so they are runnable from an installed package as well as from this checkout.

`@opencode-ai/plugin` is an **optional peer dependency** (and a dev dependency here, for building and testing the adapter). npm therefore never installs it for a standalone `--omit=dev` consumer, and the core and CLI import graphs never reach it. Adapter consumers add it deliberately:

```sh
npm install ./tasty-0.1.0.tgz @opencode-ai/plugin
```

To use it from this repository, install OpenCode 1.18.27 or newer and open the checkout:

```sh
npx opencode-ai .
```

The local adapter is registered at `.opencode/plugins/tasty.ts` and the slash command at `.opencode/commands/tasty.md`. Then invoke:

```text
/tasty
```

`/tasty` opens with `무엇을 결정해볼까요?`, examples, and free-form input. You can also provide a target immediately, for example `/tasty README의 예제 스타일`; the command instructs the agent to preserve that input exactly. After a session is compiled, `/tasty apply <session-id>` loads its latest Taste Profile so OpenCode can create or revise an artifact under those rules. The profile keeps unresolved items unresolved rather than silently inventing a choice.

The adapter exposes nine tools — `tasty_start`, `tasty_present`, `tasty_choose`, `tasty_revise_plan`, `tasty_status`, `tasty_resume`, `tasty_complete`, `tasty_compile`, `tasty_apply` — over the same `TastyService` the CLI uses, resolving storage from each tool call's `context.directory`.

## Data layout

```text
.tasty/sessions/<session-id>/events.jsonl   # private by default; gitignored
.tasty/sessions/<session-id>/session.lock   # transient; exists only while a writer holds the session
profiles/<target-slug>/v0001/TASTE.md       # intentionally committable
profiles/<target-slug>/v0001/taste.yaml
profiles/<target-slug>/v0001/decision-receipt.md
```

Session directories and event files are created with private permissions where the platform supports POSIX modes. Profiles are not ignored: committing them is an explicit user action. Tasty never invokes `git` itself.

Several Tasty processes may work on the same session on one machine. Each mutation takes an exclusive per-session lock for its whole read-decide-write sequence, so concurrent commands either serialize or fail cleanly — the event log always replays. Waiting is bounded; a command that cannot take the lock reports the holding process and exits non-zero instead of writing. A lock left by a crashed process on this host is normally reclaimed automatically, provided it still records who held it. Reclaim runs under a short-lived guard file, `session.lock.reclaim`, that is never taken from another reclaimer on age — a reclaimer that looks stalled may only be paused, and stealing its guard risks deleting a live lock. A lock whose contents cannot be read is likewise never reclaimed, at any age: it records no process, and every acquisition passes through exactly that state for a moment between creating the file and writing its metadata, so age cannot tell a crash apart from a live acquirer. In both cases later writers time out rather than reclaim; recovery is manual: with no Tasty command running, delete `session.lock.reclaim`, then `session.lock` if its recorded process is really gone or it records nothing at all. This is single-host serialization: Tasty makes no concurrency guarantee for a workspace on a network or shared filesystem.

## Core/host boundary

`src/core.ts` is deterministic state transition and validation logic. `src/storage.ts` owns JSONL persistence and the per-session mutation boundary built on `src/lock.ts`, `src/compiler.ts` validates evidenced synthesis and owns immutable output versions, and `src/service.ts` coordinates them. All of these are host-neutral.

Hosts sit on top and only translate calls: `src/cli.ts` maps argv to `TastyService`, and `src/adapters/opencode.ts` maps OpenCode custom-tool calls to the same service. Candidate generation and rule synthesis intentionally remain with the caller; the core validates provenance and persistence rather than embedding model routing or interview orchestration.

See [docs/product-contract.md](docs/product-contract.md) for semantics, limitations, and a walkthrough.
