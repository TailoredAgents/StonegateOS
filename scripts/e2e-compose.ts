import { spawnSync } from "node:child_process";

const composeArgs = process.argv.slice(2);
if (composeArgs.length === 0) {
  throw new Error("Usage: tsx scripts/e2e-compose.ts <compose arguments>");
}

const pluginProbe = spawnSync("docker", ["compose", "version"], {
  encoding: "utf8",
  stdio: "pipe",
});
const command = pluginProbe.status === 0 ? "docker" : "docker-compose";
const commandArgs =
  command === "docker"
    ? ["compose", "-f", "devops/docker-compose.yml", ...composeArgs]
    : ["-f", "devops/docker-compose.yml", ...composeArgs];

const result = spawnSync(command, commandArgs, { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
