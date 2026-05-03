import { parseLinks } from "../src/backlinks/parse.js";

const cases: Array<{ name: string; input: string; expect: number; check?: (links: ReturnType<typeof parseLinks>) => string | null }> = [
  {
    name: "single wikilink",
    input: "See [[Foo]] for details.",
    expect: 1,
    check: (l) => (l[0].kind === "wikilink" && l[0].target === "Foo" ? null : `bad: ${JSON.stringify(l[0])}`),
  },
  {
    name: "wikilink with heading and alias",
    input: "Check [[Foo#Section|the section]].",
    expect: 1,
    check: (l) =>
      l[0].kind === "wikilink" && l[0].target === "Foo" && l[0].fragment === "#Section" && l[0].alias === "the section"
        ? null
        : `bad: ${JSON.stringify(l[0])}`,
  },
  {
    name: "wikilink with block ref",
    input: "Block [[Note^abc123]] reference.",
    expect: 1,
    check: (l) => (l[0].target === "Note" && l[0].fragment === "^abc123" ? null : `bad: ${JSON.stringify(l[0])}`),
  },
  {
    name: "markdown link",
    input: "Read [the doc](Folder/Note.md).",
    expect: 1,
    check: (l) =>
      l[0].kind === "markdown" && l[0].target === "Folder/Note.md" && l[0].alias === "the doc"
        ? null
        : `bad: ${JSON.stringify(l[0])}`,
  },
  {
    name: "markdown link with fragment",
    input: "[here](docs/api.md#install)",
    expect: 1,
    check: (l) => (l[0].target === "docs/api.md" && l[0].fragment === "#install" ? null : `bad: ${JSON.stringify(l[0])}`),
  },
  {
    name: "image is not a link",
    input: "![alt](image.png)",
    expect: 0,
  },
  {
    name: "external URL not parsed as a vault link",
    input: "[google](https://example.com)",
    expect: 0,
  },
  {
    name: "link inside fenced code is skipped",
    input: "Before\n```\n[[InCode]]\n```\nAfter [[Real]].",
    expect: 1,
    check: (l) => (l[0].target === "Real" ? null : `bad: ${JSON.stringify(l[0])}`),
  },
  {
    name: "tilde fence skipped too",
    input: "~~~\n[[Skipped]]\n~~~\n[[Kept]]",
    expect: 1,
    check: (l) => (l[0].target === "Kept" ? null : `bad: ${JSON.stringify(l[0])}`),
  },
  {
    name: "two wikilinks same line",
    input: "[[A]] then [[B]]",
    expect: 2,
    check: (l) => (l[0].target === "A" && l[1].target === "B" ? null : `bad`),
  },
  {
    name: "wikilink and markdown link mixed",
    input: "[[Wiki]] and [md](file.md)",
    expect: 2,
    check: (l) => (l[0].kind === "wikilink" && l[1].kind === "markdown" ? null : `bad: ${l.map((x) => x.kind).join(",")}`),
  },
  {
    name: "anchor-only link is not a vault link",
    input: "[top](#intro)",
    expect: 0,
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const links = parseLinks(c.input);
  if (links.length !== c.expect) {
    console.log(`FAIL ${c.name}: expected ${c.expect} links, got ${links.length}`);
    console.log(`  input: ${JSON.stringify(c.input)}`);
    console.log(`  links: ${JSON.stringify(links)}`);
    fail++;
    continue;
  }
  if (c.check) {
    const err = c.check(links);
    if (err) {
      console.log(`FAIL ${c.name}: ${err}`);
      fail++;
      continue;
    }
  }
  console.log(`PASS ${c.name}`);
  pass++;
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail > 0 ? 1 : 0);
