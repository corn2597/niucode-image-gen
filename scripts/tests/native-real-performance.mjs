import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import process from "node:process";

function readFlag(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
  return process.argv[index + 1];
}

const executable = readFlag("--executable");
const outputDirectory = readFlag("--output-dir");
const reportPath = readFlag("--report");
const timeoutIndex = process.argv.indexOf("--timeout-ms");
const timeoutMs = timeoutIndex === -1 ? 240000 : Number(process.argv[timeoutIndex + 1]);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const report = { status: "running", started_at: new Date().toISOString(), timings_ms: {} };

async function writeReport() {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function startMcp() {
  const child = spawn(executable, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let buffered = "";
  let stderr = "";
  let nextId = 0;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  return {
    async request(method, params = {}) {
      const id = ++nextId;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} exceeded ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    async close({ force = false } = {}) {
      if (force) child.kill("SIGTERM");
      else child.stdin.end();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return stderr;
    },
  };
}

const runStartedAt = performance.now();
let client;
try {
  client = startMcp();
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "niucodes-real-performance", version: "1" },
  });
  report.timings_ms.mcp_startup = Math.round(performance.now() - runStartedAt);

  const generateStartedAt = performance.now();
  const generated = await client.request("tools/call", {
    name: "imagegen_generate",
    arguments: {
      prompt: "A single cobalt-blue geometric cube on a clean white studio surface, soft daylight, product photograph.",
      output: path.join(outputDirectory, `${stamp}-generate.png`),
      quality: "low",
      size: "1024x1024",
      timeoutMs,
    },
  });
  const generation = generated.result?.structuredContent;
  if (generation?.status !== "success") throw new Error(generation?.error?.message ?? "generate failed");
  report.generate = generation;
  report.timings_ms.generate_roundtrip = Math.round(performance.now() - generateStartedAt);

  const editStartedAt = performance.now();
  const edited = await client.request("tools/call", {
    name: "imagegen_edit",
    arguments: {
      prompt: "Change only the cube color from cobalt blue to emerald green. Keep the composition, white studio surface, lighting, and photographic style unchanged.",
      images: [generation.saved[0].absolute_path],
      output: path.join(outputDirectory, `${stamp}-edit.png`),
      quality: "low",
      size: "1024x1024",
      timeoutMs,
    },
  });
  const edit = edited.result?.structuredContent;
  if (edit?.status !== "success") throw new Error(edit?.error?.message ?? "edit failed");
  report.edit = edit;
  report.timings_ms.edit_roundtrip = Math.round(performance.now() - editStartedAt);
  report.status = "success";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  report.timings_ms.total = Math.round(performance.now() - runStartedAt);
  report.completed_at = new Date().toISOString();
  if (client) report.stderr = await client.close({ force: report.status !== "success" });
  await writeReport();
}

if (report.status !== "success") process.exitCode = 1;
