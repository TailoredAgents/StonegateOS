import { spawn } from "node:child_process";

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

export default async function globalTeardown(): Promise<void> {
  try {
    await run("corepack", ["pnpm", "cleanup:e2e"]);
  } catch (error) {
    console.warn("[teardown] cleanup failed", error);
  }
}
