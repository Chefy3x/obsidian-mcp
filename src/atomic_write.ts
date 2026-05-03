import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function atomicWriteFile(
  absPath: string,
  content: string,
): Promise<void> {
  const tempPath = path.join(
    path.dirname(absPath),
    `.${path.basename(absPath)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
  );

  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "wx");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, absPath);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* swallow */
      }
    }
    try {
      await fs.unlink(tempPath);
    } catch {
      /* temp may already be gone */
    }
    throw err;
  }
}
