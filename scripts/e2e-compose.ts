import { spawnSync } from "node:child_process";

const composeArgs = process.argv.slice(2);
if (composeArgs.length === 0) {
  throw new Error("Usage: tsx scripts/e2e-compose.ts <compose arguments>");
}

// The compose file lives in a generically named `devops` directory. Without an
// explicit project name, Compose can adopt `devops` and operate on containers
// created by an entirely different checkout that uses the same directory name.
// Keep every destructive E2E lifecycle command scoped to StonegateOS.
const E2E_COMPOSE_PROJECT = "stonegateos-e2e";

const pluginProbe = spawnSync("docker", ["compose", "version"], {
  encoding: "utf8",
  stdio: "pipe",
});
const command = pluginProbe.status === 0 ? "docker" : "docker-compose";
const commandArgs =
  command === "docker"
    ? [
        "compose",
        "--project-name",
        E2E_COMPOSE_PROJECT,
        "-f",
        "devops/docker-compose.yml",
        ...composeArgs,
      ]
    : [
        "--project-name",
        E2E_COMPOSE_PROJECT,
        "-f",
        "devops/docker-compose.yml",
        ...composeArgs,
      ];

const result = spawnSync(command, commandArgs, { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
