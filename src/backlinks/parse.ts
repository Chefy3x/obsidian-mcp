import { findFenceSkipRanges, isInsideAny } from "../markdown_util.js";

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

