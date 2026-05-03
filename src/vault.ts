import path from "node:path";

export class VaultPathError extends Error {
  constructor(
    message: string,
    public readonly code: "ABSOLUTE_PATH" | "PATH_ESCAPE" | "EMPTY_PATH",
  ) {
    super(message);
    this.name = "VaultPathError";
  }
}

export function resolveVaultPath(vaultRoot: string, relativePath: string): string {
  if (relativePath.length === 0) {
    throw new VaultPathError("Path is empty.", "EMPTY_PATH");
  }
  if (path.isAbsolute(relativePath)) {
    throw new VaultPathError(
      `Path must be relative to the vault root, got absolute: ${relativePath}`,
      "ABSOLUTE_PATH",
    );
  }

  const root = path.resolve(vaultRoot);
  const resolved = path.resolve(root, relativePath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new VaultPathError(
      `Path escapes vault root: ${relativePath}`,
      "PATH_ESCAPE",
    );
  }
  return resolved;
}
