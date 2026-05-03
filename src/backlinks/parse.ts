export type LinkKind = "wikilink" | "markdown";

export interface Link {
  kind: LinkKind;
  start: number;
  end: number;
  raw: string;
  target: string;
  fragment: string;
  alias: string | null;
}

export function parseLinks(content: string): Link[] {
  const skips = findFenceSkipRanges(content);
  const links: Link[] = [];

  const wikiRegex = /\[\[([^\[\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRegex.exec(content)) !== null) {
    if (isInsideAny(m.index, skips)) continue;
    const inner = m[1];
    const link = parseWikilinkInner(inner);
    if (!link) continue;
    links.push({
      kind: "wikilink",
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      ...link,
    });
  }

  const mdRegex = /(^|[^!])\[([^\[\]\n]*)\]\(([^()\n]+)\)/g;
  while ((m = mdRegex.exec(content)) !== null) {
    const matchStart = m.index + m[1].length;
    if (isInsideAny(matchStart, skips)) continue;
    const inner = m[3];
    const parsed = parseMarkdownInner(inner);
    if (!parsed) continue;
    links.push({
      kind: "markdown",
      start: matchStart,
      end: matchStart + (m[0].length - m[1].length),
      raw: m[0].slice(m[1].length),
      target: parsed.target,
      fragment: parsed.fragment,
      alias: m[2] || null,
    });
  }

  links.sort((a, b) => a.start - b.start);
  return links;
}

interface ParsedTarget {
  target: string;
  fragment: string;
  alias: string | null;
}

function parseWikilinkInner(inner: string): ParsedTarget | null {
  const trimmed = inner.trim();
  if (trimmed.length === 0) return null;

  let alias: string | null = null;
  let body = trimmed;
  const pipeIdx = trimmed.indexOf("|");
  if (pipeIdx !== -1) {
    body = trimmed.slice(0, pipeIdx).trim();
    alias = trimmed.slice(pipeIdx + 1);
  }
  if (body.length === 0) return null;

  const fragMatch = body.match(/[#^]/);
  if (fragMatch && fragMatch.index !== undefined) {
    return {
      target: body.slice(0, fragMatch.index),
      fragment: body.slice(fragMatch.index),
      alias,
    };
  }
  return { target: body, fragment: "", alias };
}

function parseMarkdownInner(inner: string): { target: string; fragment: string } | null {
  const trimmed = inner.trim();
  if (trimmed.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  if (trimmed.startsWith("#")) return null;
  if (trimmed.startsWith("mailto:") || trimmed.startsWith("tel:")) return null;

  const hashIdx = trimmed.indexOf("#");
  if (hashIdx !== -1) {
    return {
      target: trimmed.slice(0, hashIdx),
      fragment: trimmed.slice(hashIdx),
    };
  }
  return { target: trimmed, fragment: "" };
}

function findFenceSkipRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fenceRegex = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let openStart: number | null = null;
  let openMarker: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(content)) !== null) {
    const marker = m[1][0].repeat(m[1].length);
    if (openStart === null || openMarker === null) {
      openStart = m.index + m[0].length;
      openMarker = marker;
    } else if (marker[0] === openMarker[0] && marker.length >= openMarker.length) {
      ranges.push([openStart, m.index]);
      openStart = null;
      openMarker = null;
    }
  }
  if (openStart !== null) ranges.push([openStart, content.length]);
  return ranges;
}

function isInsideAny(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [a, b] of ranges) {
    if (pos >= a && pos < b) return true;
  }
  return false;
}
