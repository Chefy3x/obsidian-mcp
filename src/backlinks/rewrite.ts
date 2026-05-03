import path from "node:path";
import { parseLinks, type Link } from "./parse.js";

export interface MoveSpec {
  oldPath: string;
  newPath: string;
}

export interface RewriteResult {
  content: string;
  rewrites: number;
}

export function rewriteLinksInSource(
  sourcePath: string,
  sourceContent: string,
  move: MoveSpec,
): RewriteResult {
  const links = parseLinks(sourceContent);
  if (links.length === 0) return { content: sourceContent, rewrites: 0 };

  const oldBaseLower = stripExt(path.posix.basename(toPosix(move.oldPath))).toLowerCase();
  const newBaseNoExt = stripExt(path.posix.basename(toPosix(move.newPath)));

  const oldPosix = toPosix(move.oldPath);
  const newPosix = toPosix(move.newPath);
  const sourceDirPosix = path.posix.dirname(toPosix(sourcePath));

  let out = "";
  let cursor = 0;
  let rewrites = 0;

  for (const link of links) {
    const replacement = computeReplacement(
      link,
      sourceDirPosix,
      oldBaseLower,
      newBaseNoExt,
      oldPosix,
      newPosix,
    );
    if (replacement === null) continue;

    out += sourceContent.slice(cursor, link.start);
    out += replacement;
    cursor = link.end;
    rewrites++;
  }

  if (rewrites === 0) return { content: sourceContent, rewrites: 0 };

  out += sourceContent.slice(cursor);
  return { content: out, rewrites };
}

function computeReplacement(
  link: Link,
  sourceDirPosix: string,
  oldBaseLower: string,
  newBaseNoExt: string,
  oldPosix: string,
  newPosix: string,
): string | null {
  let replacement: string;

  if (link.kind === "wikilink") {
    const targetBaseLower = stripExt(link.target).toLowerCase();
    if (targetBaseLower !== oldBaseLower) return null;
    const aliasPart = link.alias !== null ? `|${link.alias}` : "";
    replacement = `[[${newBaseNoExt}${link.fragment}${aliasPart}]]`;
  } else {
    const linkTargetResolved = path.posix.normalize(
      path.posix.join(sourceDirPosix, link.target),
    );
    if (linkTargetResolved !== path.posix.normalize(oldPosix)) return null;

    let newTargetRelative = path.posix.relative(sourceDirPosix, newPosix);
    if (newTargetRelative.length === 0) newTargetRelative = path.posix.basename(newPosix);
    if (
      !newTargetRelative.startsWith("./") &&
      !newTargetRelative.startsWith("../")
    ) {
      newTargetRelative = `./${newTargetRelative}`;
    }
    const aliasText = link.alias ?? "";
    replacement = `[${aliasText}](${newTargetRelative}${link.fragment})`;
  }

  if (replacement === link.raw) return null;
  return replacement;
}

export function recomputeOwnLinksAfterMove(
  content: string,
  oldSourcePath: string,
  newSourcePath: string,
  options?: { skipTargetsInsideFolder?: string },
): RewriteResult {
  const links = parseLinks(content);
  if (links.length === 0) return { content, rewrites: 0 };

  const oldSourceDir = path.posix.dirname(toPosix(oldSourcePath));
  const newSourceDir = path.posix.dirname(toPosix(newSourcePath));
  if (oldSourceDir === newSourceDir) return { content, rewrites: 0 };

  const skipFolder = options?.skipTargetsInsideFolder
    ? toPosix(options.skipTargetsInsideFolder)
    : null;

  let out = "";
  let cursor = 0;
  let rewrites = 0;

  for (const link of links) {
    if (link.kind !== "markdown") continue;

    const oldBaseDir = oldSourceDir === "." ? "" : oldSourceDir;
    const absTarget = path.posix.normalize(
      path.posix.join(oldBaseDir, link.target),
    );

    if (
      skipFolder !== null &&
      (absTarget === skipFolder || absTarget.startsWith(`${skipFolder}/`))
    ) {
      continue;
    }

    let newRelative = path.posix.relative(newSourceDir, absTarget);
    if (newRelative.length === 0) newRelative = path.posix.basename(absTarget);
    if (
      !newRelative.startsWith("./") &&
      !newRelative.startsWith("../")
    ) {
      newRelative = `./${newRelative}`;
    }

    const aliasText = link.alias ?? "";
    const replacement = `[${aliasText}](${newRelative}${link.fragment})`;
    if (replacement === link.raw) continue;

    out += content.slice(cursor, link.start);
    out += replacement;
    cursor = link.end;
    rewrites++;
  }

  if (rewrites === 0) return { content, rewrites: 0 };
  out += content.slice(cursor);
  return { content: out, rewrites };
}

function stripExt(name: string): string {
  const ext = path.posix.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
