# Standalone Tasty Core and CLI Implementation Plan

> **For Hermes:** Use subagent-driven-development and strict TDD to execute this plan.

**Goal:** Make Tasty usable without OpenCode while retaining OpenCode as an optional adapter over the same host-neutral core.

**Architecture:** Keep deterministic state, persistence, compilation, and application in host-neutral modules. Add a standalone Node CLI that maps explicit commands to `TastyService`; move the OpenCode integration under an adapter namespace and keep a compatibility export. OpenCode must not be required to install or execute the standalone product.

**Tech Stack:** TypeScript, Node.js 22+, Vitest, YAML.

---

## Acceptance criteria

1. `npm install` and all standalone CLI commands work without installing OpenCode or importing `@opencode-ai/plugin`.
2. The package identity and primary export describe independent `tasty`, not `tasty-opencode`.
3. A CLI executable supports the complete existing lifecycle: `start`, `present`, `choose`, `revise-plan`, `status`, `resume`, `complete`, `compile`, and `apply`.
4. Structured inputs use JSON strings or `@file` JSON; command results are JSON on stdout and errors are non-zero with useful stderr text.
5. `--root <path>` selects the workspace; default is the current directory. The CLI preserves exact target text when it is supplied in JSON.
6. OpenCode integration lives in `src/adapters/opencode.ts` and is exported only from a dedicated optional package subpath. `src/plugin.ts` may remain as a compatibility re-export.
7. `@opencode-ai/plugin` is not a production dependency of the core/CLI path. Existing OpenCode adapter behavior and tool names continue to pass tests.
8. Add a real subprocess integration test proving the complete standalone flow from start through apply in a temporary workspace without OpenCode.
9. Update README and product contract so Tasty is presented as an independent product and OpenCode as one optional host adapter.
10. `npm run check`, `npm audit --audit-level=high`, and `git diff --check` pass.

## Task 1: Lock package boundary with failing tests

- Modify `package.json` to add build/CLI metadata only after tests establish required behavior.
- Add tests that verify the core/CLI import graph and package metadata do not require OpenCode at runtime.
- Verify RED before production changes.

## Task 2: Add standalone CLI

- Create `src/cli.ts` and a small argument/input parser if needed.
- Map commands directly to `TastyService` without embedding model routing, preference inference, or automatic candidate generation.
- Support JSON and `@file`, stable JSON stdout, useful non-zero failures, and `--root`.
- Test command parsing and service dispatch with RED-GREEN cycles.

## Task 3: Isolate the OpenCode adapter

- Create `src/adapters/opencode.ts` from the existing plugin implementation.
- Keep `src/plugin.ts` as a compatibility re-export if useful.
- Move `@opencode-ai/plugin` out of production dependencies while keeping adapter development/tests available.
- Preserve all nine tool contracts and existing plugin tests.

## Task 4: Prove the host-neutral lifecycle

- Add a subprocess integration test invoking the built CLI for start → present → choose → complete → compile → apply.
- Ensure no OpenCode executable or runtime is involved.
- Run focused tests and then the complete suite.

## Task 5: Documentation and final verification

- Rewrite README installation/usage around standalone Tasty first.
- Document OpenCode as optional adapter and retain its setup instructions separately.
- Update `docs/product-contract.md` front door wording to include CLI and adapter entry points without changing decision semantics.
- Run full checks and inspect package contents/import boundaries.
