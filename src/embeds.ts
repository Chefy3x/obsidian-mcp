import { findFenceSkipRanges, isInsideAny } from "./markdown_util.js";

export interface Embed {
  rawText: string;
  target: string;
  fragment: string;
  alias: string | null;
  start: number;
  end: number;
}

export function parseEmbeds(content: string): Embed[] {
  const skips = findFenceSkipRanges(content);
  const embeds: Embed[] = [];
  const regex = /!\[\[([^\[\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    if (isInsideAny(m.index, skips)) continue;
    const inner = m[1].trim();
    if (inner.length === 0) continue;

    let alias: string | null = null;
    let body = inner;
    const pipe = inner.indexOf("|");
    if (pipe !== -1) {
      body = inner.slice(0, pipe).trim();
      alias = inner.slice(pipe + 1);
    }
    const fragMatch = body.match(/[#^]/);
    let target: string;
    let fragment: string;
    if (fragMatch && fragMatch.index !== undefined) {
      target = body.slice(0, fragMatch.index);
      fragment = body.slice(fragMatch.index);
    } else {
      target = body;
      fragment = "";
    }
    if (target.length === 0) continue;

    embeds.push({
      rawText: m[0],
      target,
      fragment,
      alias,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return embeds;
}

export function extractBlockById(content: string, blockId: string): string | null {
  const marker = `^${blockId}`;
  const idx = content.indexOf(marker);
  if (idx === -1) return null;

  const blockEndIdx = content.indexOf("\n", idx);
  const blockEnd = blockEndIdx === -1 ? content.length : blockEndIdx;
  const before = content.slice(0, idx);
  const lastBlankLine = before.search(/\n\s*\n[^]*$/);
  const blockStart = lastBlankLine === -1 ? 0 : lastBlankLine + 1;

  const block = content.slice(blockStart, blockEnd);
  return block.replace(new RegExp(`\\s*\\^${blockId}\\s*$`), "").trim();
}
