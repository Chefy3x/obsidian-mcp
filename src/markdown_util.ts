export function findFenceSkipRanges(content: string): Array<[number, number]> {
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
    } else if (
      marker[0] === openMarker[0] &&
      marker.length >= openMarker.length
    ) {
      ranges.push([openStart, m.index]);
      openStart = null;
      openMarker = null;
    }
  }
  if (openStart !== null) ranges.push([openStart, content.length]);
  return ranges;
}

export function isInsideAny(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [a, b] of ranges) {
    if (pos >= a && pos < b) return true;
  }
  return false;
}
