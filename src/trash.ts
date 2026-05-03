import { promises as fs } from "node:fs";
import path from "node:path";

export const TRASH_DIR = ".trash";

export interface TrashResult {
  trashAbs: string;
  trashRel: string;
}

export async function moveToTrash(
  vaultRoot: string,
  absPath: string,
  relPath: string,
): Promise<TrashResult> {
  const root = path.resolve(vaultRoot);
  const relPosix = toPosix(relPath);

  let trashRel = path.posix.join(TRASH_DIR, relPosix);
  let trashAbs = path.join(root, trashRel);

  if (await pathExists(trashAbs)) {
    trashRel = withTimestampSuffix(relPosix);
    trashAbs = path.join(root, trashRel);
  }

  await fs.mkdir(path.dirname(trashAbs), { recursive: true });
  await fs.rename(absPath, trashAbs);

  return { trashAbs, trashRel };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function withTimestampSuffix(relPosix: string): string {
  const ext = path.posix.extname(relPosix);
  const baseNoExt = path.posix.basename(relPosix, ext);
  const parent = path.posix.dirname(relPosix);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const newName = `${baseNoExt}.${ts}${ext}`;
  const trashParent =
    parent === "." ? TRASH_DIR : path.posix.join(TRASH_DIR, parent);
  return path.posix.join(trashParent, newName);
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
