#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveAntigravityPaths } from "./paths.js";
import { createConversationRenamerServer } from "./tools.js";

async function main(): Promise<void> {
  const paths = resolveAntigravityPaths();
  const server = createConversationRenamerServer(paths);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[conversation-renamer-mcp] 启动失败: ${msg}\n`);
  process.exit(1);
});
