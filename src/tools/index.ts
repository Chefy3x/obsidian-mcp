import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { registerVaultRead } from "./vault_read.js";
import { registerVaultList } from "./vault_list.js";
import { registerVaultWrite } from "./vault_write.js";
import { registerVaultPatch } from "./vault_patch.js";
import { registerVaultCreateFolder } from "./vault_create_folder.js";
import { registerVaultDelete } from "./vault_delete.js";
import { registerVaultReindex } from "./vault_reindex.js";
import { registerVaultMove } from "./vault_move.js";
import { registerVaultMoveFolder } from "./vault_move_folder.js";
import { registerVaultDeleteFolder } from "./vault_delete_folder.js";

export function registerAllTools(server: McpServer, config: Config): void {
  registerVaultRead(server, config);
  registerVaultList(server, config);
  registerVaultWrite(server, config);
  registerVaultPatch(server, config);
  registerVaultCreateFolder(server, config);
  registerVaultDelete(server, config);
  registerVaultReindex(server, config);
  registerVaultMove(server, config);
  registerVaultMoveFolder(server, config);
  registerVaultDeleteFolder(server, config);
}
