import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixturePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwIBfuyx5QAAAABJRU5ErkJggg==";

function packageRootArg(argv) {
  const index = argv.indexOf("--package-root");
  if (index === -1 || !argv[index + 1] || argv.length !== 2) throw new Error("Usage: node scripts/tests/packaged-e2e.mjs --package-root <package-root>");
  return path.resolve(argv[index + 1]);
}

async function exists(filePath) {
  try { await stat(filePath); return true; } catch { return false; }
}

async function findPowerShellScripts(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findPowerShellScripts(entryPath));
    else if (entry.name.toLowerCase().endsWith(".ps1")) found.push(entryPath);
  }
  return found;
}

function executableFor(packageRoot) {
  const files = process.platform === "win32"
    ? ["niucodes-image-gen-win-x64.exe"]
    : process.arch === "arm64"
      ? ["niucodes-image-gen-macos-arm64", "niucodes-image-gen-macos-x64"]
      : ["niucodes-image-gen-macos-x64", "niucodes-image-gen-macos-arm64"];
  const override = process.env.NIUCODES_IMAGE_GEN_E2E_EXECUTABLE;
  if (override) return path.resolve(override);
  return path.join(packageRoot, "bin", files[0]);
}

function runNative(executable, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["run", "--request-stdin"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = { code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`native process exited with ${code ?? signal}`), result));
    });
    child.stdin.write(`${JSON.stringify(request)}\n`, "utf8");
    // Keep the pipe open. A valid v2 request must not wait for EOF.
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
  try { await run(`http://127.0.0.1:${port}/v1`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function complete(response, command) {
  const type = command === "generate" ? "image_generation.completed" : "image_edit.completed";
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "x-request-id": `packaged-${command}` });
  // No newline or EOF: package must return from the completed Base64 event.
  response.write(`data: ${JSON.stringify({ type, b64_json: fixturePngBase64 })}`);
}

function readResult(result) {
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  return JSON.parse(result.stdout);
}

const requestedPackageRoot = packageRootArg(process.argv.slice(2));
const executable = executableFor(requestedPackageRoot);
// Cross-architecture acceptance supplies an executable override. Its adjacent
// config.json belongs to that package, not to the host-platform package root.
const packageRoot = process.env.NIUCODES_IMAGE_GEN_E2E_EXECUTABLE
  ? path.resolve(path.dirname(executable), "..")
  : requestedPackageRoot;
if (!(await exists(executable))) throw new Error(`Packaged executable was not found: ${executable}`);
assert.deepEqual(await findPowerShellScripts(packageRoot), [], "Release package must not contain a PowerShell runner.");

const root = await mkdtemp(path.join(os.tmpdir(), "niucodes imagegen packaged v2 中文 "));
const sourceA = path.join(root, "源图 A.png");
const sourceB = path.join(root, "源图 B.png");
await writeFile(sourceA, Buffer.from(fixturePngBase64, "base64"));
await writeFile(sourceB, Buffer.from(fixturePngBase64, "base64"));

let requestCount = 0;
await withMockImagesApi((request, response, body) => {
  requestCount += 1;
  assert.equal(request.headers.authorization, "Bearer packaged-e2e-key");
  if (request.url === "/v1/images/generations") {
    const payload = JSON.parse(body);
    assert.equal(payload.prompt, '中文生成 prompt with spaces and "quotes"');
    assert.equal(payload.n, 1);
    assert.equal(payload.partial_images, 0);
    complete(response, "generate");
    return;
  }
  assert.equal(request.url, "/v1/images/edits");
  assert.match(request.headers["content-type"], /^multipart\/form-data/);
  const multipart = body.toString("latin1");
  assert.match(body.toString("utf8"), /保留构图，将围巾改为深蓝色/);
  assert.equal((multipart.match(/name="image"/g) ?? []).length, 2);
  assert.match(multipart, /name="partial_images"\r\n\r\n0/);
  complete(response, "edit");
}, async (baseURL) => {
  await writeFile(path.join(packageRoot, "config.json"), JSON.stringify({ apiKey: "packaged-e2e-key", baseURL, timeoutMs: 5000 }));
  const generate = readResult(await runNative(executable, {
    version: 2,
    command: "generate",
    workspace: path.join(root, "workspace 中文"),
    prompt: '中文生成 prompt with spaces and "quotes"',
    quality: "low",
    size: "1024x1024",
  }));
  assert.equal(generate.status, "success");
  assert.equal(generate.exit_code, 0);
  assert.equal((await readFile(generate.saved[0].absolute_path)).toString("base64"), fixturePngBase64);
  assert.equal(generate.timing_ms.stream_completed_frame_terminated, false);

  const edit = readResult(await runNative(executable, {
    version: 2,
    command: "edit",
    workspace: path.join(root, "workspace edit 中文"),
    prompt: "保留构图，将围巾改为深蓝色",
    images: [sourceA, sourceB],
    quality: "low",
    size: "1024x1024",
  }));
  assert.equal(edit.status, "success");
  assert.equal(edit.exit_code, 0);
  assert.equal((await readFile(edit.saved[0].absolute_path)).toString("base64"), fixturePngBase64);
});

assert.equal(requestCount, 2, "one API request per native invocation");
process.stdout.write(`${JSON.stringify({ status: "success", platform: `${process.platform}-${process.arch}`, package_root: packageRoot, executable, generate: true, edit: true })}\n`);
