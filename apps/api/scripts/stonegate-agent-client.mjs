import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const config = JSON.parse(
  await readFile(
    process.env.STONEGATE_AGENT_CREDENTIAL_FILE ??
      join(homedir(), ".local", "share", "stonegate-agent", "credentials.json"),
    "utf8",
  ),
);
if (
  config.url !== "https://stonegate-api.onrender.com/api/mcp" ||
  !/^sg_agent_[A-Za-z0-9_-]{43}$/.test(config.token)
)
  throw new Error("Invalid Stonegate connection configuration");
const [command, tool, arg, destination] = process.argv.slice(2);
if (command === "recording" || command === "media") {
  const output = command === "media" ? destination : arg;
  if (
    !/^[a-f0-9-]{36}$/i.test(tool ?? "") ||
    !output ||
    (command === "media" && !/^\d{1,2}$/.test(arg ?? ""))
  )
    throw new Error(
      "Usage: recording CALL_UUID OUTPUT_FILE | media MESSAGE_UUID INDEX OUTPUT_FILE",
    );
  const path =
    command === "media" ? `media/${tool}/${arg}` : `recordings/${tool}`;
  const response = await fetch(`${config.url}/${path}`, {
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`Download unavailable (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(resolve(output), bytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ saved: resolve(output), bytes: bytes.length }));
} else {
  const client = new Client({
    name: "stonegate-local-agent-client",
    version: "1.0.0",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      }),
    );
    if (command === "list")
      console.log(JSON.stringify(await client.listTools(), null, 2));
    else if ((command === "call" || command === "call-file") && tool) {
      const args = arg
        ? JSON.parse(
            command === "call-file"
              ? await readFile(resolve(arg), "utf8")
              : arg,
          )
        : {};
      const result = await client.callTool({ name: tool, arguments: args });
      console.log(JSON.stringify(result, null, 2));
      if (result.isError) process.exitCode = 1;
    } else
      throw new Error(
        "Usage: list | call TOOL JSON | call-file TOOL JSON_FILE | recording CALL_UUID OUTPUT_FILE | media MESSAGE_UUID INDEX OUTPUT_FILE",
      );
  } finally {
    await client.close();
  }
}
