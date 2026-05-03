import { promises as fs } from "node:fs";
import path from "node:path";
import { parseLinks } from "./parse.js";
import { atomicWriteFile } from "../atomic_write.js";

const CACHE_DIR = ".obsidian-mcp-cache";
const CACHE_FILE = "backlinks.json";
const CACHE_VERSION = 1;

interface FileEntry {
  mtimeMs: number;
  size: number;
  wikilinkBasenames: string[];
  markdownTargets: string[];
}

interface CacheData {
  version: number;
  files: Record<string, FileEntry>;
}

export interface BacklinkIndexStats {
  filesScanned: number;
  filesParsed: number;
  filesFromCache: number;
  filesDeleted: number;
}

export class BacklinkIndex {
  private vaultRoot: string;
  private data: CacheData;

  private constructor(vaultRoot: string, data: CacheData) {
    this.vaultRoot = vaultRoot;
    this.data = data;
  }

  static async load(vaultRoot: string): Promise<BacklinkIndex> {
    const root = path.resolve(vaultRoot);
    const cachePath = path.join(root, CACHE_DIR, CACHE_FILE);
    let data: CacheData = { version: CACHE_VERSION, files: {} };
    try {
      const raw = await fs.readFile(cachePath, "utf8");
      const parsed = JSON.parse(raw) as CacheData;
      if (parsed && parsed.version === CACHE_VERSION && parsed.files) {
        data = parsed;
      }
    } catch {
      /* no cache yet; start fresh */
    }
    return new BacklinkIndex(root, data);
  }

  async refresh(): Promise<BacklinkIndexStats> {
    const stats: BacklinkIndexStats = {
      filesScanned: 0,
      filesParsed: 0,
      filesFromCache: 0,
      filesDeleted: 0,
    };

    const seen = new Set<string>();
    await this.walkAndUpdate("", seen, stats);

    for (const relPath of Object.keys(this.data.files)) {
      if (!seen.has(relPath)) {
        delete this.data.files[relPath];
        stats.filesDeleted++;
      }
    }

    return stats;
  }

  private async walkAndUpdate(
    relDir: string,
    seen: Set<string>,
    stats: BacklinkIndexStats,
  ): Promise<void> {
    const absDir = path.join(this.vaultRoot, relDir);
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue;

      const childRel =
        relDir === ""
          ? dirent.name
          : path.posix.join(toPosix(relDir), dirent.name);

      if (dirent.isDirectory()) {
        await this.walkAndUpdate(childRel, seen, stats);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (!dirent.name.toLowerCase().endsWith(".md")) continue;

      stats.filesScanned++;
      seen.add(childRel);

      const absChild = path.join(this.vaultRoot, childRel);
      let stat;
      try {
        stat = await fs.stat(absChild);
      } catch {
        continue;
      }

      const cached = this.data.files[childRel];
      if (
        cached &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.size === stat.size
      ) {
        stats.filesFromCache++;
        continue;
      }

      let content: string;
      try {
        content = await fs.readFile(absChild, "utf8");
      } catch {
        continue;
      }

      this.data.files[childRel] = parseFileEntry(childRel, content, stat);
      stats.filesParsed++;
    }
  }

  async save(): Promise<void> {
    const cacheDir = path.join(this.vaultRoot, CACHE_DIR);
    await fs.mkdir(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, CACHE_FILE);
    await atomicWriteFile(cachePath, JSON.stringify(this.data));
  }

  findSources(targetRelPath: string): string[] {
    const targetPosix = path.posix.normalize(toPosix(targetRelPath));
    const targetBaseLower = stripExt(
      path.posix.basename(targetPosix),
    ).toLowerCase();

    const sources: string[] = [];
    for (const [sourcePath, entry] of Object.entries(this.data.files)) {
      if (sourcePath === targetPosix) continue;
      if (entry.wikilinkBasenames.includes(targetBaseLower)) {
        sources.push(sourcePath);
        continue;
      }
      if (entry.markdownTargets.includes(targetPosix)) {
        sources.push(sourcePath);
      }
    }
    return sources;
  }

  forget(relPath: string): void {
    delete this.data.files[toPosix(relPath)];
  }

  clear(): void {
    this.data.files = {};
  }

  size(): number {
    return Object.keys(this.data.files).length;
  }

  allMdFiles(): string[] {
    return Object.keys(this.data.files);
  }
}

function parseFileEntry(
  relPath: string,
  content: string,
  stat: import("node:fs").Stats,
): FileEntry {
  const links = parseLinks(content);
  const wikilinkBasenames: string[] = [];
  const markdownTargets: string[] = [];
  const sourceDirPosix = path.posix.dirname(toPosix(relPath));

  for (const link of links) {
    if (link.kind === "wikilink") {
      wikilinkBasenames.push(stripExt(link.target).toLowerCase());
    } else {
      const baseDir = sourceDirPosix === "." ? "" : sourceDirPosix;
      const resolved = path.posix.normalize(
        path.posix.join(baseDir, link.target),
      );
      markdownTargets.push(resolved);
    }
  }

  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    wikilinkBasenames,
    markdownTargets,
  };
}

function stripExt(name: string): string {
  const ext = path.posix.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
