import { readFile } from "node:fs/promises";
import path from "node:path";

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

export function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1]!);
}

export interface ImportGraph {
  files: string[];
  packages: string[];
}

/**
 * Walks the static import graph of an entry module, returning every reachable file (relative to
 * `root`) and every bare specifier. `resolve` maps a relative specifier onto the file that actually
 * holds it, so the same walk serves TypeScript sources and built JavaScript.
 */
export async function importGraph(
  root: string,
  entry: string,
  resolve: (specifier: string) => string = (specifier) => specifier,
): Promise<ImportGraph> {
  const files: string[] = [];
  const packages = new Set<string>();
  const queue = [path.resolve(root, entry)];
  const seen = new Set<string>(queue);

  while (queue.length > 0) {
    const current = queue.shift()!;
    files.push(path.relative(root, current));
    for (const specifier of specifiers(await readFile(current, "utf8"))) {
      if (!specifier.startsWith(".")) {
        packages.add(specifier);
        continue;
      }
      const resolved = path.resolve(path.dirname(current), resolve(specifier));
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return { files, packages: [...packages].sort() };
}
