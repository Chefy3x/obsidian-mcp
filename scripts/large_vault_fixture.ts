import { promises as fs } from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: tsx large_vault_fixture.ts <path>");
  process.exit(1);
}

await fs.mkdir(target, { recursive: true });

const FOLDERS = 30;
const FILES_PER_FOLDER = 35;
const TOTAL = FOLDERS * FILES_PER_FOLDER;

const folderNames: string[] = [];
for (let i = 0; i < FOLDERS; i++) {
  folderNames.push(`folder-${String(i).padStart(2, "0")}`);
}
const fileNames: string[] = [];
for (let i = 0; i < TOTAL; i++) {
  fileNames.push(`note-${String(i).padStart(4, "0")}`);
}

const start = Date.now();
let written = 0;

for (let f = 0; f < FOLDERS; f++) {
  const folder = folderNames[f];
  await fs.mkdir(path.join(target, folder), { recursive: true });

  for (let n = 0; n < FILES_PER_FOLDER; n++) {
    const idx = f * FILES_PER_FOLDER + n;
    const fileName = fileNames[idx];
    const filePath = path.join(target, folder, `${fileName}.md`);

    const linkTargets: string[] = [];
    for (let k = 1; k <= 3; k++) {
      const targetIdx = (idx + k * 7) % TOTAL;
      linkTargets.push(fileNames[targetIdx]);
    }

    const isLarge = idx % 200 === 0;

    const lines: string[] = [
      "---",
      `title: ${fileName}`,
      `idx: ${idx}`,
      "tags: [fixture]",
      "---",
      "",
      `# ${fileName}`,
      "",
      `Wikilink: [[${linkTargets[0]}]]`,
      `Markdown link: [also](../${folderNames[(f + 1) % FOLDERS]}/${linkTargets[1]}.md)`,
      `Wikilink with alias: [[${linkTargets[2]}|alias]]`,
      "",
      "```",
      `[[${fileNames[(idx + 1) % TOTAL]}]] in code (must not be parsed)`,
      "```",
      "",
    ];

    if (isLarge) {
      const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20000);
      lines.push(filler);
    } else {
      lines.push(
        "Body paragraph one. Some content.",
        "",
        "Body paragraph two with a tail.",
      );
    }

    await fs.writeFile(filePath, lines.join("\n"));
    written++;
  }
}

const elapsed = Date.now() - start;
console.log(`Wrote ${written} files across ${FOLDERS} folders in ${elapsed}ms`);
const sizes = await Promise.all(
  Array.from({ length: 6 }, (_, i) => i * 200).map(async (idx) => {
    const f = Math.floor(idx / FILES_PER_FOLDER);
    const stat = await fs.stat(
      path.join(target, folderNames[f], `${fileNames[idx]}.md`),
    );
    return { idx, size: stat.size };
  }),
);
console.log("Large file sizes:", sizes);
