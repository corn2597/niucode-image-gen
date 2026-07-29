import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";

import { DEFAULT_TIMEOUT_MS, defaultOutputDirectory, resolveInvocation } from "../lib/image-client.mjs";
import { installSkill } from "../lib/installer.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "niucodes-image-gen.mjs");
const fixturePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwIBfuyx5QAAAABJRU5ErkJggg==";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "niucodes imagegen v2 "));
}

async function runWithStdin(request, { env = process.env, cwd = repoRoot, keepStdinOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "run", "--request-stdin"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = { code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`runner exited with ${code ?? signal}`), result));
    });
    child.stdin.write(`\uFEFF${JSON.stringify(request)}\n`, "utf8");
    if (!keepStdinOpen) child.stdin.end();
  });
}

async function withMockImagesApi(handler, run) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => handler(request, response, Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function completed(response, command, { close = false } = {}) {
  const type = command === "generate" ? "image_generation.completed" : "image_edit.completed";
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "x-request-id": `mock-${command}` });
  // Intentionally omit LF/EOF by default: this is the proxy behavior that
  // used to keep customer requests alive until their full timeout.
  response.write(`data: ${JSON.stringify({ type, b64_json: fixturePngBase64 })}`);
  if (close) response.end();
}

async function writeConfig(root, baseURL, extras = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "config.json"), JSON.stringify({ apiKey: "test-api-key", baseURL, ...extras }));
}

function parseOneJson(result) {
  assert.equal(result.stdout.trim().split("\n").length, 1, "stdout must contain exactly one JSON line");
  return JSON.parse(result.stdout);
}

test("v2 skill documentation mandates one native stdin request and no status files", async () => {
  const skill = await readFile(path.join(repoRoot, "SKILL.md"), "utf8");
  assert.match(skill, /run --request-stdin/);
  assert.match(skill, /does not require stdin EOF/i);
  assert.doesNotMatch(skill, /request-file/i);
  assert.doesNotMatch(skill, /status-file/i);
});

test("v2 generate preserves Chinese prompt and returns one strict JSON result", async () => {
  const root = await tempDir();
  const workspace = path.join(root, "工作区 中文 空格");
  let requests = 0;
  await withMockImagesApi((request, response, body) => {
    requests += 1;
    assert.equal(request.url, "/v1/images/generations");
    const payload = JSON.parse(body);
    assert.equal(payload.prompt, '一只橙色猫，带“红色围巾”，window light');
    assert.equal(payload.n, 1);
    assert.equal(payload.partial_images, 0);
    completed(response, "generate");
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL);
    const result = await runWithStdin({ version: 2, command: "generate", workspace, prompt: '一只橙色猫，带“红色围巾”，window light', quality: "low", size: "1024x1024" }, {
      env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot },
      keepStdinOpen: true,
    });
    const payload = parseOneJson(result);
    assert.equal(payload.status, "success");
    assert.equal(payload.exit_code, 0);
    assert.equal(payload.phase, "complete");
    assert.equal(payload.request_id, "mock-generate");
    assert.equal(payload.api_request_id, "mock-generate");
    assert.equal(payload.saved.length, 1);
    assert.match(payload.saved[0].absolute_path, /工作区 中文 空格[\\/]image-outputs[\\/]niucodes-image-gen/);
    assert.equal((await readFile(payload.saved[0].absolute_path)).toString("base64"), fixturePngBase64);
    assert.equal(typeof payload.timing_ms.api, "number");
    assert.equal(typeof payload.timing_ms.post_complete, "number");
  });
  assert.equal(requests, 1);
});

test("v2 edit uploads multiple absolute input images without PowerShell argument parsing", async () => {
  const root = await tempDir();
  const sourceA = path.join(root, "输入 图片 A.png");
  const sourceB = path.join(root, "输入 图片 B.png");
  await writeFile(sourceA, Buffer.from(fixturePngBase64, "base64"));
  await writeFile(sourceB, Buffer.from(fixturePngBase64, "base64"));
  await withMockImagesApi((request, response, body) => {
    assert.equal(request.url, "/v1/images/edits");
    assert.match(request.headers["content-type"], /^multipart\/form-data/);
    assert.match(body.toString("utf8"), /保持构图，将围巾改为深蓝色/);
    assert.equal((body.toString("latin1").match(/name="image"/g) ?? []).length, 2);
    completed(response, "edit");
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL);
    const result = await runWithStdin({ version: 2, command: "edit", workspace: path.join(root, "workspace"), prompt: "保持构图，将围巾改为深蓝色", images: [sourceA, sourceB], size: "1024x1024", quality: "low" }, {
      env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot },
    });
    const payload = parseOneJson(result);
    assert.equal(payload.status, "success");
    assert.equal(payload.saved.length, 1);
  });
});

test("v2 rejects intermediate-file and endpoint fields before any API request", async () => {
  const root = await tempDir();
  const skillRoot = path.join(root, "skill");
  await writeConfig(skillRoot, "http://127.0.0.1:1/v1");
  let failure;
  try {
    await runWithStdin({ version: 2, command: "generate", prompt: "test", statusFile: path.join(root, "old.json") }, { env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot } });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  const payload = JSON.parse(failure.stdout);
  assert.equal(payload.status, "failed");
  assert.equal(payload.phase, "input");
  assert.match(payload.error.message, /statusFile/);
});

test("v2 validates an unwritable-like output before attempting the image API", async () => {
  const root = await tempDir();
  const skillRoot = path.join(root, "skill");
  await writeConfig(skillRoot, "http://127.0.0.1:1/v1");
  let failure;
  try {
    await runWithStdin({ version: 2, command: "generate", prompt: "test", output: path.join(skillRoot, "forbidden.png") }, { env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot } });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  const payload = JSON.parse(failure.stdout);
  assert.equal(payload.phase, "initialization");
  assert.match(payload.error.message, /outside the skill directory/);
});

test("completed Base64 returns before upstream SSE EOF and closes the socket", async () => {
  const root = await tempDir();
  let clientClosed = false;
  await withMockImagesApi((_request, response) => {
    response.once("close", () => { clientClosed = true; });
    completed(response, "generate");
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 5000 });
    const started = Date.now();
    const result = await runWithStdin({ version: 2, command: "generate", workspace: path.join(root, "workspace"), prompt: "complete immediately" }, { env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot } });
    assert.equal(parseOneJson(result).status, "success");
    assert.ok(Date.now() - started < 2000);
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(clientClosed, true);
});

test("timeout uses the configured full deadline and returns a terminal result", async () => {
  const root = await tempDir();
  let clientClosed = false;
  await withMockImagesApi((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    response.once("close", () => { clientClosed = true; });
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 1000 });
    let failure;
    try {
      await runWithStdin({ version: 2, command: "generate", workspace: path.join(root, "workspace"), prompt: "wait for timeout" }, { env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot } });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    const payload = JSON.parse(failure.stdout);
    assert.equal(payload.status, "timeout");
    assert.equal(payload.exit_code, 124);
    assert.equal(payload.phase, "response_incomplete");
    assert.equal(payload.error.code, "timeout");
    assert.equal(payload.retry_safe, false);
    assert.match(payload.error.message, /timed out after 1000ms/i);
  });
  assert.equal(clientClosed, true);
});

test("system temp working directory falls back to configured persistent output", async () => {
  const root = await tempDir();
  const configPath = path.join(root, "config.json");
  const persistent = path.join(root, "Pictures", "niucodes-image-gen");
  await writeFile(configPath, JSON.stringify({ apiKey: "test-key", defaultOutputDir: persistent }));
  const invocation = await resolveInvocation("generate", { config: configPath, prompt: "test", image: [] }, { cwd: path.join(os.tmpdir(), "codex-ephemeral-task") });
  assert.equal(invocation.output, persistent);
  assert.equal(DEFAULT_TIMEOUT_MS, 600000);
});

test("unwritable implicit workspace candidate falls through to the configured persistent output", async () => {
  const root = await tempDir();
  const configPath = path.join(root, "config.json");
  const workspaceFile = path.join(root, "not-a-workspace-file");
  const persistent = path.join(root, "persistent-output");
  await writeFile(workspaceFile, "not a directory");
  await writeFile(configPath, JSON.stringify({ apiKey: "test-key", defaultOutputDir: persistent }));
  const invocation = await resolveInvocation("generate", {
    config: configPath,
    prompt: "test",
    image: [],
    workspace: workspaceFile,
  }, { cwd: path.join(os.tmpdir(), "niucodes-image-gen-non-workspace") });
  assert.match(invocation.output, /not-a-workspace-file[\\/]image-outputs[\\/]niucodes-image-gen$/);
  assert.equal(invocation.outputCandidates.length, 3);
  assert.equal(invocation.outputCandidates[1], persistent);
  assert.equal(invocation.outputCandidates[2], defaultOutputDirectory());
});

test("native request uses the next implicit output directory when workspace output is unavailable", async () => {
  const root = await tempDir();
  const workspaceFile = path.join(root, "workspace-is-a-file");
  const persistent = path.join(root, "persistent-output");
  const taskCwd = path.join(os.tmpdir(), "niucodes-image-gen-non-workspace");
  await writeFile(workspaceFile, "not a directory");
  await mkdir(taskCwd, { recursive: true });
  await withMockImagesApi((_request, response) => completed(response, "generate"), async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { defaultOutputDir: persistent });
    const result = await runWithStdin({
      version: 2,
      command: "generate",
      workspace: workspaceFile,
      prompt: "fallback output",
    }, {
      cwd: taskCwd,
      env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot },
    });
    const payload = parseOneJson(result);
    assert.equal(payload.status, "success");
    assert.ok(payload.saved[0].absolute_path.startsWith(`${persistent}${path.sep}`));
  });
});

test("macOS /private/tmp alias is never treated as a task workspace", { skip: process.platform !== "darwin" }, async () => {
  const root = await tempDir();
  const configPath = path.join(root, "config.json");
  const persistent = path.join(root, "persistent-output");
  await writeFile(configPath, JSON.stringify({ apiKey: "test-key", defaultOutputDir: persistent }));
  const invocation = await resolveInvocation("generate", { config: configPath, prompt: "test", image: [] }, { cwd: "/private/tmp/niucodes-image-gen-test" });
  assert.equal(invocation.output, persistent);
});

test("missing workspace uses persistent application data, never a system temp directory", () => {
  assert.equal(
    defaultOutputDirectory({ home: "/Users/example", platform: "darwin" }),
    "/Users/example/Library/Application Support/niucodes-image-gen/outputs",
  );
  assert.equal(
    defaultOutputDirectory({ home: "C:\\Users\\example", platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" } }),
    "C:\\Users\\example\\AppData\\Local\\niucodes-image-gen\\outputs",
  );
  assert.equal(
    defaultOutputDirectory({ home: "/home/example", platform: "linux", env: {} }),
    "/home/example/.local/share/niucodes-image-gen/outputs",
  );
});

test("installer migrates only the historical 570-second default to ten minutes", async () => {
  const root = await tempDir();
  const installDir = path.join(root, "installed skill");
  await mkdir(installDir, { recursive: true });
  await writeFile(path.join(installDir, "config.json"), JSON.stringify({
    apiKey: "preserved",
    timeoutMs: 570000,
    defaultOutputDir: path.join(root, "Pictures", "niucodes-image-gen"),
  }));
  await installSkill({
    packageRoot: repoRoot,
    installDir,
    configPath: path.join(root, "config.toml"),
    home: root,
  });
  const config = JSON.parse(await readFile(path.join(installDir, "config.json"), "utf8"));
  assert.equal(config.apiKey, "preserved");
  assert.equal(config.timeoutMs, 600000);
  assert.equal(config.defaultOutputDir, defaultOutputDirectory({ home: root, platform: process.platform }));
});
