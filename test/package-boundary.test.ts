import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importGraph } from "./import-graph.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Tasty is host-independent: it is a core library plus a standalone CLI, and nothing else. The host
 * integration that once lived here was removed, so this file is the single place in the repository
 * allowed to name it — everywhere else, naming it is the regression these tests catch.
 */
const REMOVED_HOST = "opencode";
const REMOVED_PACKAGE = "@opencode-ai/plugin";
const SELF = path.relative(repoRoot, fileURLToPath(import.meta.url));

/** Generated or vendored trees are not part of the repository's own surface. */
const NOT_OURS = new Set(["node_modules", "dist", "coverage", ".git", ".tasty"]);

interface ExportTarget {
  types: string;
  default: string;
}

interface PackageManifest {
  name: string;
  description: string;
  bin?: Record<string, string>;
  files?: string[];
  exports: Record<string, ExportTarget | string>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

async function manifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as PackageManifest;
}

function fromSource(specifier: string): string {
  return specifier.replace(/\.js$/, ".ts");
}

async function exists(target: string): Promise<boolean> {
  return access(path.join(repoRoot, target)).then(
    () => true,
    () => false,
  );
}

/** Every file the repository owns, relative to its root, excluding generated and vendored trees. */
async function ownedFiles(directory = ""): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, directory), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (NOT_OURS.has(entry.name)) continue;
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await ownedFiles(relative)));
    else if (entry.isFile()) found.push(relative);
  }
  return found.sort();
}

/** Files whose path or text still names the removed host, which is what "host-independent" forbids. */
async function hostReferences(): Promise<string[]> {
  const offenders: string[] = [];
  for (const file of await ownedFiles()) {
    if (file === SELF) continue;
    if (file.toLowerCase().includes(REMOVED_HOST)) {
      offenders.push(file);
      continue;
    }
    const text = await readFile(path.join(repoRoot, file), "utf8").catch(() => "");
    if (text.toLowerCase().includes(REMOVED_HOST)) offenders.push(file);
  }
  return offenders;
}

describe("host-independent package boundary", () => {
  it("identifies the package as independent Tasty with a CLI entry point", async () => {
    const pkg = await manifest();
    expect(pkg.name).toBe("tasty");
    expect(pkg.description).toMatch(/standalone CLI/i);
    expect(pkg.bin).toMatchObject({ tasty: expect.stringContaining("cli") });
    expect(pkg.scripts.build).toBeTypeOf("string");
  });

  it("exports the core and the CLI, and no host adapter or plugin subpath", async () => {
    const pkg = await manifest();
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./cli", "./package.json"]);
    expect(pkg.exports["."]).toEqual({ types: "./dist/src/index.d.ts", default: "./dist/src/index.js" });
    expect(pkg.exports["./cli"]).toEqual({ types: "./dist/src/cli.d.ts", default: "./dist/src/cli.js" });
    expect(pkg.exports["./package.json"]).toBe("./package.json");
  });

  it("publishes every export target and the bin from the shipped build output", async () => {
    const pkg = await manifest();
    expect(pkg.files).toContain("dist/src");
    expect(pkg.bin!.tasty).toBe("./dist/src/cli.js");
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (subpath === "./package.json") continue;
      const entry = target as ExportTarget;
      expect(entry.default.startsWith("./dist/src/"), `${subpath} default`).toBe(true);
      expect(entry.types.startsWith("./dist/src/"), `${subpath} types`).toBe(true);
    }
  });

  it("declares no host dependency in any dependency field, not even an optional peer", async () => {
    const pkg = await manifest();
    expect(pkg.dependencies).toEqual({ yaml: expect.any(String) });
    expect(pkg.devDependencies).not.toHaveProperty(REMOVED_PACKAGE);
    expect(pkg.peerDependencies ?? {}).toEqual({});
    expect(pkg.peerDependenciesMeta ?? {}).toEqual({});
  });

  it("locks exactly the tree the manifest declares, with no host package anywhere in it", async () => {
    const pkg = await manifest();
    const lock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8")) as {
      name: string;
      packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
    };
    const root = lock.packages[""]!;

    expect(lock.name).toBe(pkg.name);
    expect(root.dependencies).toEqual(pkg.dependencies);
    expect(root.devDependencies).toEqual(pkg.devDependencies);
    expect(Object.keys(lock.packages).filter((name) => name.includes("@opencode-ai/"))).toEqual([]);
  });

  it("holds no host adapter or plugin compatibility module in the source tree", async () => {
    expect(await exists(path.join("src", "plugin.ts"))).toBe(false);
    expect(await exists(path.join("src", "adapters"))).toBe(false);
  });

  it("tracks no host integration directory in the workspace", async () => {
    expect(await exists(`.${REMOVED_HOST}`)).toBe(false);
  });

  it("reaches only Node built-ins and yaml from the core and CLI import graphs", async () => {
    for (const entry of ["src/index.ts", "src/cli.ts"]) {
      const graph = await importGraph(repoRoot, entry, fromSource);
      expect(graph.packages.every((name) => name.startsWith("node:") || name === "yaml"), entry).toBe(true);
    }
  });

  it("names the removed host nowhere in source, package metadata, or documentation", async () => {
    expect(await hostReferences()).toEqual([]);
  });

  it("documents source-tree invocation rather than claiming a repository install links the executable", async () => {
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    expect(readme).not.toMatch(/`npm install` links the `tasty` executable/);
    expect(readme).toContain("node dist/src/cli.js");
    expect(readme).toMatch(/npm pack/);
    expect(readme).toMatch(/--omit=dev/);
  });
});
