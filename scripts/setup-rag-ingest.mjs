import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const root = new URL("..", import.meta.url);
const qdrantHealthUrl = "http://127.0.0.1:6333/healthz";
const embeddingHealthUrl = `http://127.0.0.1:${process.env.EMBEDDING_PORT ?? "8080"}/health`;

let startedQdrant = false;
let embeddingProcess;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `code ${code}`}`));
      }
    });
  });
}

async function isHealthy(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(name, url, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isHealthy(url)) return;
    await sleep(1000);
  }

  throw new Error(`${name} did not become healthy at ${url}`);
}

async function startQdrantIfNeeded() {
  if (await isHealthy(qdrantHealthUrl)) {
    console.log("[setup] Qdrant already running");
    return;
  }

  console.log("[setup] starting Qdrant for RAG ingest");
  await run("docker", ["compose", "-f", "docker-compose.qdrant.yml", "up", "-d"]);
  startedQdrant = true;
  await waitForHealth("Qdrant", qdrantHealthUrl);
}

async function startEmbeddingIfNeeded() {
  if (await isHealthy(embeddingHealthUrl)) {
    console.log("[setup] embedding service already running");
    return;
  }

  console.log("[setup] starting embedding service for RAG ingest");
  embeddingProcess = spawn("bash", ["customer-embedding-demo/scripts/dev.sh"], {
    cwd: root,
    stdio: "inherit",
  });

  embeddingProcess.on("exit", (code, signal) => {
    if (!embeddingProcess.killed && code !== 0) {
      console.error(`[setup] embedding service exited early with ${signal ?? `code ${code}`}`);
    }
  });

  await waitForHealth("embedding service", embeddingHealthUrl, 300_000);
}

async function cleanup() {
  if (embeddingProcess && !embeddingProcess.killed) {
    console.log("[setup] stopping temporary embedding service");
    embeddingProcess.kill("SIGTERM");
  }

  if (startedQdrant) {
    console.log("[setup] stopping temporary Qdrant");
    await run("docker", ["compose", "-f", "docker-compose.qdrant.yml", "down"]);
  }
}

try {
  await startQdrantIfNeeded();
  await startEmbeddingIfNeeded();
  await run("npm", ["run", "rag:ingest", "--workspace=customer-agents"]);
} finally {
  await cleanup();
}
