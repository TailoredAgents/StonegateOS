// Local Codex bridge. The integration is hosted in Stonegate's live API;
// this adapter only supplies a private credential and forwards MCP tools.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const file =
  process.env.STONEGATE_AGENT_CREDENTIAL_FILE ??
  join(homedir(), ".local", "share", "stonegate-agent", "credentials.json");
const config = JSON.parse(await readFile(file, "utf8"));
if (
  config.url !== "https://stonegate-api.onrender.com/api/mcp" ||
  !/^sg_agent_[A-Za-z0-9_-]{43}$/.test(config.token)
)
  throw new Error("Invalid Stonegate connection configuration");
const remote = new Client({
  name: "stonegate-desktop-agent",
  version: "1.0.0",
});
await remote.connect(
  new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
  }),
);
const server = new Server(
  { name: "stonegate", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: remote.getInstructions() },
);
server.setRequestHandler(ListToolsRequestSchema, async () =>
  remote.listTools(),
);
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  remote.callTool(request.params),
);
await server.connect(new StdioServerTransport());
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await remote.close();
  await server.close();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
process.stdin.once("end", () => void close());
