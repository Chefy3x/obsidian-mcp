import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  vaultPath: z.string().min(1, "vaultPath is required"),
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG_PATH = path.join(
  homedir(),
  ".config",
  "obsidian-mcp",
  "config.json",
);

export async function loadConfig(): Promise<Config> {
  const envOverride = process.env.OBSIDIAN_MCP_VAULT;
  if (envOverride) {
    const resolved = path.resolve(envOverride);
    await assertVaultReadable(resolved);
    return { vaultPath: resolved };
  }

  const configPath = process.env.OBSIDIAN_MCP_CONFIG ?? DEFAULT_CONFIG_PATH;

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    throw new Error(
      `Failed to read config at ${configPath}. ` +
        `Either create it with { "vaultPath": "/path/to/vault" } ` +
        `or set OBSIDIAN_MCP_VAULT in the environment.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Config at ${configPath} is not valid JSON.`);
  }

  const config = ConfigSchema.parse(parsed);
  const resolved = path.resolve(config.vaultPath);
  await assertVaultReadable(resolved);
  return { vaultPath: resolved };
}

async function assertVaultReadable(vaultPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(vaultPath);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Vault path does not exist: ${vaultPath}`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${vaultPath}`);
  }
}
