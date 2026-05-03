import { findFenceSkipRanges, isInsideAny } from "./markdown_util.js";

export interface Heading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  line: number;
  start: number;
  end: number;
}

const HEADING_REGEX = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/;

export function parseHeadings(content: string): Heading[] {
  const skips = findFenceSkipRanges(content);
  const headings: Heading[] = [];

  let pos = 0;
  let lineNum = 1;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isInsideAny(pos, skips)) {
      const m = line.match(HEADING_REGEX);
      if (m && m[2].trim().length > 0) {
        headings.push({
          level: m[1].length as 1 | 2 | 3 | 4 | 5 | 6,
          text: m[2].trim(),
          line: lineNum,
          start: pos,
          end: pos + line.length,
        });
      }
    }
    pos += line.length + 1;
    lineNum++;
  }

  return headings;
}

export interface HeadingSection {
  heading: Heading;
  contentStart: number;
  contentEnd: number;
  text: string;
}

export function extractHeadingSection(
  content: string,
  headingText: string,
): HeadingSection | null {
  const headings = parseHeadings(content);
  const targetIdx = headings.findIndex(
    (h) => h.text.toLowerCase() === headingText.toLowerCase(),
  );
  if (targetIdx === -1) return null;

  const target = headings[targetIdx];
  const contentStart = target.end + 1;

  let contentEnd = content.length;
  for (let i = targetIdx + 1; i < headings.length; i++) {
    if (headings[i].level <= target.level) {
      contentEnd = headings[i].start;
      break;
    }
  }

  return {
    heading: target,
    contentStart,
    contentEnd,
    text: content.slice(contentStart, contentEnd).trim(),
  };
}
