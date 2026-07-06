#!/usr/bin/env node
import { startPlaneMcpHttpServer } from "./http.js";

const server = await startPlaneMcpHttpServer();

console.log(`plane-cli MCP listening on ${server.url}`);

let closing = false;

async function closeAndExit(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void closeAndExit();
});
process.on("SIGTERM", () => {
  void closeAndExit();
});
