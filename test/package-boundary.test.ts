import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importGraph, specifiers } from "./import-graph.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCODE_PACKAGE = "@opencode-ai/plugin";

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

describe("standalone package boundary", () => {
  it("identifies the package as independent Tasty with a CLI entry point", async () => {
    const pkg = await manifest();
    expect(pkg.name).toBe("tasty");
    expect(pkg.description).not.toMatch(/for OpenCode/i);
    expect(pkg.bin).toMatchObject({ tasty: expect.stringContaining("cli") });
    expect(pkg.scripts.build).toBeTypeOf("string");
  });

  it("exports built JavaScript with type declarations for the core, the CLI, and the adapter subpaths", async () => {
    const pkg = await manifest();
    expect(pkg.exports["."]).toEqual({ types: "./dist/src/index.d.ts", default: "./dist/src/index.js" });
    expect(pkg.exports["./cli"]).toEqual({ types: "./dist/src/cli.d.ts", default: "./dist/src/cli.js" });
    expect(pkg.exports["./adapters/opencode"]).toEqual({
      types: "./dist/src/adapters/opencode.d.ts",
      default: "./dist/src/adapters/opencode.js",
    });
    expect(pkg.exports["./plugin"]).toEqual({ types: "./dist/src/plugin.d.ts", default: "./dist/src/plugin.js" });
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

  it("keeps OpenCode out of production dependencies and offers it as an optional peer", async () => {
    const pkg = await manifest();
    expect(pkg.dependencies).not.toHaveProperty(OPENCODE_PACKAGE);
    expect(pkg.dependencies).toHaveProperty("yaml");
    expect(pkg.devDependencies).toHaveProperty(OPENCODE_PACKAGE);
    expect(pkg.peerDependencies).toHaveProperty(OPENCODE_PACKAGE);
    expect(pkg.peerDependenciesMeta?.[OPENCODE_PACKAGE]?.optional).toBe(true);
  });

  it("locks the same tree the manifest declares, so `npm ci --omit=dev` installs no OpenCode", async () => {
    const pkg = await manifest();
    const lock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8")) as {
      name: string;
      packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; dev?: boolean }>;
    };
    const root = lock.packages[""]!;

    expect(lock.name).toBe(pkg.name);
    expect(root.dependencies).toEqual(pkg.dependencies);
    expect(root.devDependencies).toEqual(pkg.devDependencies);
    expect(lock.packages[`node_modules/${OPENCODE_PACKAGE}`]?.dev).toBe(true);
  });

  it("never reaches OpenCode from the core or CLI import graph", async () => {
    for (const entry of ["src/index.ts", "src/cli.ts"]) {
      const graph = await importGraph(repoRoot, entry, fromSource);
      expect(graph.packages).not.toContain(OPENCODE_PACKAGE);
      expect(graph.packages.every((name) => name.startsWith("node:") || name === "yaml")).toBe(true);
      expect(graph.files).not.toContain("src/plugin.ts");
      expect(graph.files).not.toContain(path.join("src", "adapters", "opencode.ts"));
    }
  });

  it("keeps the OpenCode adapter isolated behind its own module", async () => {
    const adapter = await importGraph(repoRoot, "src/adapters/opencode.ts", fromSource);
    expect(adapter.packages).toContain(OPENCODE_PACKAGE);
    const compatibility = await readFile(path.join(repoRoot, "src", "plugin.ts"), "utf8");
    expect(specifiers(compatibility)).toEqual(["./adapters/opencode.js"]);
  });

  it("documents source-tree invocation rather than claiming a repository install links the executable", async () => {
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    expect(readme).not.toMatch(/`npm install` links the `tasty` executable/);
    expect(readme).toContain("node dist/src/cli.js");
    expect(readme).toMatch(/npm pack/);
    expect(readme).toMatch(/--omit=dev/);
  });
});
