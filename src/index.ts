#!/usr/bin/env node
import { startHttpServer } from './http-server.js';
import { startMcpServer } from './mcp-server.js';
import { startupCleanup } from './preview-manager.js';
import { CONFIG } from './utils.js';

async function main() {
  console.error(`[live-preview-mcp] starting… (HTTP on ${CONFIG.BIND_HOST}:${CONFIG.PORT})`);
  // Reap any leftover containers from previous crashes
  await startupCleanup();
  await startHttpServer();
  await startMcpServer();
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
