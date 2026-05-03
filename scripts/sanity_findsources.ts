import { BacklinkIndex } from "../src/backlinks/index.js";

const vaultRoot = process.env.OBSIDIAN_MCP_VAULT;
if (!vaultRoot) {
  console.error("Set OBSIDIAN_MCP_VAULT first.");
  process.exit(1);
}

const idx = await BacklinkIndex.load(vaultRoot);
await idx.refresh();

const target = process.argv[2] ?? "Archive/Target.md";
const sources = idx.findSources(target);
console.log(`findSources(${JSON.stringify(target)}) =>`);
for (const s of sources) console.log(`  ${s}`);
console.log(`(${sources.length} sources)`);
