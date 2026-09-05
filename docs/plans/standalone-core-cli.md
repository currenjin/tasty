# Host-Independent Tasty Core and CLI

**Status:** implemented. This document records the contract the code now holds, and supersedes the
earlier plan that kept a host integration alongside the CLI.

**Goal:** Tasty is a self-contained product — a host-neutral core plus a standalone CLI. It ships no
adapter, plugin, or custom-tool surface for any host application, and needs none to install or run.

**Architecture:** Deterministic state, persistence, compilation, and application live in host-neutral
modules. `src/cli.ts` maps explicit commands to `TastyService`; `src/index.ts` exports the same
service for any program that would rather hold the lifecycle directly. There is no third path in.

**Tech Stack:** TypeScript, Node.js 22+, Vitest, YAML.

---

## Acceptance criteria

1. `npm install` and every standalone CLI command work with no host application installed.
2. The package identity and primary export describe independent `tasty`.
3. The CLI supports the complete lifecycle: `start`, `present`, `choose`, `revise-plan`, `status`,
   `resume`, `complete`, `compile`, and `apply`.
4. Structured inputs use JSON strings or `@file` JSON; results are JSON on stdout, and errors exit
   non-zero with useful stderr text.
5. `--root <path>` selects the workspace; default is the current directory. Target text supplied in
   JSON is preserved exactly.
6. The package exports exactly `.`, `./cli`, and `./package.json`. No adapter or plugin subpath
   exists, and no source module implements one.
7. `yaml` is the only runtime dependency; the remaining dev dependencies are the build and test
   toolchain and never ship. No host package appears in any dependency field — dependencies, dev
   dependencies, peer dependencies, or `peerDependenciesMeta` — and none appears in the lockfile.
8. No host integration directory is tracked in the repository or present in a checkout.
9. A subprocess integration test proves the complete flow from start through apply in a temporary
   workspace, against the packed and `--omit=dev` installed tarball.
10. README and product contract present Tasty solely as an independent core plus standalone CLI.
11. `npm run check`, `npm run build`, `npm audit --audit-level=high`, `npm pack --dry-run`, and
    `git diff --check` pass, and the packed file list carries only the built core and CLI.

## Boundary regression coverage

`test/package-boundary.test.ts` is the single place in the repository allowed to name the removed
host, because naming it is exactly what those assertions detect. It checks package identity and
exports, every dependency field, the lockfile, the absence of adapter and plugin modules and of a
host integration directory, the core and CLI import graphs, and the whole owned file tree for stale
references.

`test/cli-integration.test.ts` proves the same boundary against a real install: the consumer tree is
`tasty` plus `yaml`, the tarball ships only `dist/src` with no host integration module, the runtime
import graph reaches only Node built-ins and `yaml`, and no host subpath is importable.

## Non-goals

Restoring a host adapter, a plugin entry point, or a slash-command surface. Callers that want a
conversational front door build it on `TastyService`; Tasty does not ship one and does not load
into a host.
