import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const composeFile = "docker-compose.qdrant.yml";
let shuttingDown = false;

function runDockerCompose(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "-f", composeFile, ...args], {
      cwd: new URL("../..", import.meta.url),
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`docker compose ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[customer-qdrant] received ${signal}, stopping Qdrant`);
  try {
    await runDockerCompose(["down"]);
    console.log("[customer-qdrant] Qdrant stopped");
  } catch (error) {
    console.error("[customer-qdrant] failed to stop Qdrant", error);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  console.log("[customer-qdrant] starting Qdrant");
  await runDockerCompose(["up", "-d"]);
  console.log("[customer-qdrant] Qdrant is running at http://127.0.0.1:6333");

  while (!shuttingDown) {
    await sleep(1000);
  }
} catch (error) {
  console.error("[customer-qdrant] failed to start Qdrant", error);
  process.exit(1);
}

