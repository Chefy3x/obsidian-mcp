import { rewriteLinksInSource } from "../src/backlinks/rewrite.js";

interface Case {
  name: string;
  source: string;
  content: string;
  move: { oldPath: string; newPath: string };
  expected: string;
  expectedRewrites: number;
}

const cases: Case[] = [
  {
    name: "basic wikilink rewrite (rename in place)",
    source: "Index.md",
    content: "See [[Foo]] for details.",
    move: { oldPath: "Foo.md", newPath: "Bar.md" },
    expected: "See [[Bar]] for details.",
    expectedRewrites: 1,
  },
  {
    name: "wikilink preserves fragment and alias",
    source: "Index.md",
    content: "Check [[Foo#Section|the section]].",
    move: { oldPath: "Foo.md", newPath: "Bar.md" },
    expected: "Check [[Bar#Section|the section]].",
    expectedRewrites: 1,
  },
  {
    name: "wikilink preserves block ref",
    source: "Index.md",
    content: "Block [[Foo^abc123]] reference.",
    move: { oldPath: "Foo.md", newPath: "Bar.md" },
    expected: "Block [[Bar^abc123]] reference.",
    expectedRewrites: 1,
  },
  {
    name: "wikilink path move keeps basename: no rewrite when basename unchanged",
    source: "Index.md",
    content: "[[Foo]]",
    move: { oldPath: "OldFolder/Foo.md", newPath: "NewFolder/Foo.md" },
    expected: "[[Foo]]",
    expectedRewrites: 0,
  },
  {
    name: "markdown link rewrite within same folder",
    source: "Inbox/Index.md",
    content: "Read [the doc](Foo.md).",
    move: { oldPath: "Inbox/Foo.md", newPath: "Inbox/Bar.md" },
    expected: "Read [the doc](./Bar.md).",
    expectedRewrites: 1,
  },
  {
    name: "markdown link rewrite across folders updates relative path",
    source: "Inbox/Index.md",
    content: "Read [the doc](Foo.md).",
    move: { oldPath: "Inbox/Foo.md", newPath: "Archive/2026/Foo.md" },
    expected: "Read [the doc](../Archive/2026/Foo.md).",
    expectedRewrites: 1,
  },
  {
    name: "markdown link preserves fragment",
    source: "Index.md",
    content: "[here](docs/api.md#install)",
    move: { oldPath: "docs/api.md", newPath: "docs/v2/api.md" },
    expected: "[here](./docs/v2/api.md#install)",
    expectedRewrites: 1,
  },
  {
    name: "non-matching wikilink left alone",
    source: "Index.md",
    content: "[[Other]]",
    move: { oldPath: "Foo.md", newPath: "Bar.md" },
    expected: "[[Other]]",
    expectedRewrites: 0,
  },
  {
    name: "mixed wikilink + markdown both rewritten",
    source: "Index.md",
    content: "[[Foo]] and [link](Foo.md)",
    move: { oldPath: "Foo.md", newPath: "Bar.md" },
    expected: "[[Bar]] and [link](./Bar.md)",
    expectedRewrites: 2,
  },
  {
    name: "code-fenced occurrence is NOT rewritten",
    source: "Index.md",
    content: "```\n[[Foo]]\n```\n[[Foo]]",
    move: { oldPath: "Foo.md", newPath: "Bar.md" },
    expected: "```\n[[Foo]]\n```\n[[Bar]]",
    expectedRewrites: 1,
  },
  {
    name: "case-insensitive wikilink match",
    source: "Index.md",
    content: "[[foo]] and [[FOO]]",
    move: { oldPath: "Foo.md", newPath: "Bar.md" },
    expected: "[[Bar]] and [[Bar]]",
    expectedRewrites: 2,
  },
  {
    name: "no links in file -> no change, rewrites=0",
    source: "Index.md",
    content: "Just some text without any links.",
    move: { oldPath: "Foo.md", newPath: "Bar.md" },
    expected: "Just some text without any links.",
    expectedRewrites: 0,
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const { content, rewrites } = rewriteLinksInSource(c.source, c.content, c.move);
  if (content !== c.expected || rewrites !== c.expectedRewrites) {
    console.log(`FAIL ${c.name}`);
    console.log(`  expected (${c.expectedRewrites}): ${JSON.stringify(c.expected)}`);
    console.log(`  got      (${rewrites}): ${JSON.stringify(content)}`);
    fail++;
    continue;
  }
  console.log(`PASS ${c.name}`);
  pass++;
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
