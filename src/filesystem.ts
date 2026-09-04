import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export async function assertNoSymbolicLinks(rootDir: string, targetPath: string): Promise<void> {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path escapes project root");

  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function readUtf8NoFollow(filePath: string): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function appendUtf8NoFollow(filePath: string, content: string, mode = 0o600): Promise<void> {
  const handle = await open(filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

export async function writeUtf8ExclusiveNoFollow(filePath: string, content: string, mode = 0o600): Promise<void> {
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}
