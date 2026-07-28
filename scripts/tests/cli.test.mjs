import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import {
  DEFAULT_EDIT_SIZE,
  DEFAULT_GENERATE_SIZE,
  resolveConfigPath,
  resolveInvocation,
} from "../lib/image-client.mjs";
import { installSkill, removeLegacyMcpServerConfig } from "../lib/installer.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(".");
const scriptPath = path.join(repoRoot, "scripts", "niucodes-image-gen.mjs");
const fixturePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s4Xv2QAAAAASUVORK5CYII=";
const tempDirectories = [];

async function runWithStdin(file, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`Command exited with ${code ?? signal}`), result));
    });
    child.stdin.end(input, "utf8");
  });
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "niucodes-image-gen-"));
  tempDirectories.push(dir);
  return dir;
}

async function writePng(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(fixturePngBase64, "base64"));
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function withMockServer(handler, run) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => handler(req, res, Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function streamCompleted(response, command, { partialImages = 0 } = {}) {
  const prefix = command === "generate" ? "image_generation" : "image_edit";
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "x-request-id": `mock-${prefix}-request`,
    "cache-control": "no-cache",
  });
  for (let index = 0; index < partialImages; index += 1) {
    response.write(`data: ${JSON.stringify({ type: `${prefix}.partial_image`, b64_json: fixturePngBase64, partial_image_index: index })}\n\n`);
  }
  response.end(`data: ${JSON.stringify({ type: `${prefix}.completed`, b64_json: fixturePngBase64 })}\n\ndata: [DONE]\n\n`);
}

function completedPayload(command) {
  const prefix = command === "generate" ? "image_generation" : "image_edit";
  return JSON.stringify({ type: `${prefix}.completed`, b64_json: fixturePngBase64 });
}

async function withHttpProxy(run) {
  const proxy = createServer((request, response) => {
    const target = new URL(request.url);
    const upstream = httpRequest({
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers: request.headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => response.destroy());
    request.pipe(upstream);
  });
  proxy.on("connect", (request, clientSocket, head) => {
    const [hostname, port = "443"] = request.url.split(":");
    const upstream = createConnection({ host: hostname, port: Number(port) });
    upstream.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.once("error", () => clientSocket.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  }
}

test("skill uses a root config file and has no stored key or key setter flow", async () => {
  const skill = await readFile(path.join(repoRoot, "SKILL.md"), "utf8");
  const config = JSON.parse(await readFile(path.join(repoRoot, "config.json"), "utf8"));
  assert.equal(resolveConfigPath(undefined), path.join(repoRoot, "config.json"));
  assert.equal(config.apiKey, "");
  assert.match(skill, /only API credential source/i);
  assert.doesNotMatch(skill, /set-skill-api-key|OPENAI_API_KEY|API_KEY:/i);
});

test("skill uses its bundled native streaming stdin entrypoint and does not prescribe MCP", async () => {
  const skill = await readFile(path.join(repoRoot, "SKILL.md"), "utf8");
  assert.match(skill, /bundled native executable/i);
  assert.match(skill, /\$HOME\/Pictures\/niucodes-image-gen/i);
  assert.match(skill, /\$env:USERPROFILE\\Pictures\\niucodes-image-gen/i);
  assert.match(skill, /Never default to the current workspace, a repository, the skill directory, or a temporary directory/i);
  assert.match(skill, /run --request-stdin/i);
  assert.match(skill, /SSE image stream/i);
  assert.match(skill, /partial_images: 0/i);
  assert.match(skill, /Never first create a request file, a temporary shell script, or a PowerShell script/i);
  assert.match(skill, /quoted here-document/i);
  assert.match(skill, /\$request \| & \(Join-Path \$env:USERPROFILE/i);
  assert.match(skill, /Keep that \*same\* terminal alive until it exits/i);
  assert.match(skill, /while \(result\.session_id\)/);
  assert.match(skill, /yield_time_ms: 300000/);
  assert.match(skill, /Do not set `sandbox_permissions`, `justification`, or `prefix_rule`/);
  assert.match(skill, /const executable = "\/Users\/example\/\.codex\/skills\/niucodes-image-gen\/bin\/niucodes-image-gen-macos-arm64"/);
  assert.match(skill, /const requestJson = JSON\.stringify\(\{/);
  assert.match(skill, /const cmd = `"\$\{executable\}" run --request-stdin <<'NIUCODES_REQUEST'/);
  assert.doesNotMatch(skill, /sandbox_permissions: "require_escalated"/);
  assert.doesNotMatch(skill, /prefix_rule:/);
  assert.match(skill, /variable must be `let result`, never `const`/);
  assert.match(skill, /stdout is empty or invalid JSON, read that request's `statusFile` exactly once/i);
  assert.match(skill, /never falls back to non-streaming and never retries/i);
  assert.match(skill, /every returned `saved\[\*\]\.markdown` string on its own line \*\*verbatim\*\*/i);
  assert.match(skill, /Do not replace it with a basename, label, or prose such as `generate-1`/i);
  assert.match(skill, /literal `!\[\.\.\.\]\(absolute-path\)` is required so the image renders/i);
  assert.doesNotMatch(skill, /invoke-imagegen\.sh|invoke-imagegen\.ps1/);
  assert.doesNotMatch(skill, /imagegen_generate|imagegen_edit|native MCP/i);
  assert.doesNotMatch(await readFile(scriptPath, "utf8"), /runMcpServer|mcp-server/);
});

test("Windows installation entrypoint runs the bundled executable in install mode", async () => {
  const installer = await readFile(path.join(repoRoot, "scripts", "install-windows.cmd"), "utf8");
  assert.match(installer, /niucodes-image-gen-win-x64\.exe/i);
  assert.match(installer, /"%EXECUTABLE%" install/i);
  assert.match(installer, /Restart Codex Desktop/i);
});

test("legacy MCP config removal preserves unrelated server configuration", () => {
  const initial = '[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.niucodes_image_gen]\ncommand = "old"\nargs = ["mcp"]\n';
  const updated = removeLegacyMcpServerConfig(initial);
  assert.match(updated, /\[mcp_servers\.other\]/);
  assert.doesNotMatch(updated, /\[mcp_servers\.niucodes_image_gen\]/);
});

test("installer copies the native executable, preserves API config, and removes legacy MCP config", async () => {
  const tempDir = await createTempDir();
  const sourceRoot = path.join(tempDir, "source skill");
  const installDir = path.join(tempDir, "installed skill");
  const configPath = path.join(tempDir, "codex", "config.toml");
  await mkdir(path.join(sourceRoot, "bin"), { recursive: true });
  await writeFile(path.join(sourceRoot, "SKILL.md"), "---\nname: niucodes-image-gen\ndescription: test\n---\n");
  await writeFile(path.join(sourceRoot, "config.json"), '{"apiKey":"template-key"}');
  await writeFile(path.join(sourceRoot, "bin", "niucodes-image-gen-macos-arm64"), "binary");
  await mkdir(installDir, { recursive: true });
  await writeFile(path.join(installDir, "config.json"), '{"apiKey":"preserved-key"}');
  await mkdir(path.join(installDir, "bin"), { recursive: true });
  await writeFile(path.join(installDir, "bin", "obsolete-installer.exe"), "obsolete binary");
  await mkdir(path.join(installDir, "scripts"), { recursive: true });
  await writeFile(path.join(installDir, "scripts", "invoke-imagegen.ps1"), "legacy runner");
  await writeFile(path.join(installDir, "scripts", "invoke-imagegen.sh"), "legacy runner");
  await writeFile(path.join(installDir, "scripts", "unrecognized-legacy-runner.ps1"), "legacy runner");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.niucodes_image_gen]\ncommand = "old"\nargs = ["mcp"]\n');

  const result = await installSkill({ packageRoot: sourceRoot, installDir, configPath, platform: "darwin", arch: "arm64" });
  assert.equal(result.status, "success");
  assert.equal(result.executable, path.join(installDir, "bin", "niucodes-image-gen-macos-arm64"));
  assert.equal(result.protocol, "stream-stdin-v2");
  assert.equal(result.removed_legacy_mcp_config, true);
  assert.equal(await readFile(path.join(installDir, "config.json"), "utf8"), '{"apiKey":"preserved-key"}');
  assert.equal(await exists(path.join(installDir, "bin", "obsolete-installer.exe")), false);
  assert.equal(await exists(path.join(installDir, "scripts", "invoke-imagegen.ps1")), false);
  assert.equal(await exists(path.join(installDir, "scripts", "invoke-imagegen.sh")), false);
  assert.equal(await exists(path.join(installDir, "scripts")), false);
  const codexConfig = await readFile(configPath, "utf8");
  assert.match(codexConfig, /\[mcp_servers\.other\]/);
  assert.doesNotMatch(codexConfig, /\[mcp_servers\.niucodes_image_gen\]/);
});

test("Apple Silicon installation resolves the native entrypoint and removes legacy MCP config", async () => {
  const tempDir = await createTempDir();
  const sourceRoot = path.join(tempDir, "source skill");
  const installDir = path.join(tempDir, "installed skill");
  const configPath = path.join(tempDir, "codex config", "config.toml");
  await mkdir(path.join(sourceRoot, "bin"), { recursive: true });
  await writeFile(path.join(sourceRoot, "SKILL.md"), "---\nname: niucodes-image-gen\ndescription: test\n---\n");
  await writeFile(path.join(sourceRoot, "config.json"), '{"apiKey":"template"}');
  await writeFile(path.join(sourceRoot, "bin", "niucodes-image-gen-macos-arm64"), "binary");
  await mkdir(installDir, { recursive: true });
  await writeFile(path.join(installDir, "config.json"), '{"apiKey":"preserved"}');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '[mcp_servers.niucodes_image_gen]\ncommand = "old"\nargs = ["mcp"]\n');

  const result = await installSkill({ packageRoot: sourceRoot, installDir, configPath, platform: "darwin", arch: "arm64" });
  assert.equal(result.status, "success");
  assert.equal(result.executable, path.join(installDir, "bin", "niucodes-image-gen-macos-arm64"));
  assert.equal(result.protocol, "stream-stdin-v2");
  assert.equal(await readFile(path.join(installDir, "config.json"), "utf8"), '{"apiKey":"preserved"}');
  assert.doesNotMatch(await readFile(configPath, "utf8"), /\[mcp_servers\.niucodes_image_gen\]/);
});

test("generate forwards prompt verbatim and reads the key only from config.json", async () => {
  const tempDir = await createTempDir();
  const configPath = path.join(tempDir, "config.json");
  const outputPath = path.join(tempDir, "generated.png");
  await withMockServer(async (req, res, body) => {
    assert.equal(req.url, "/v1/images/generations");
    assert.equal(req.headers.authorization, "Bearer config-key");
    const payload = JSON.parse(body);
    assert.equal(payload.prompt, "  Use EXACT wording: teal cube / 1990s film.  ");
    assert.equal(payload.size, DEFAULT_GENERATE_SIZE);
    assert.equal(payload.stream, true);
    assert.equal(payload.partial_images, 0);
    streamCompleted(res, "generate");
  }, async (baseURL) => {
    await writeFile(configPath, JSON.stringify({ apiKey: "config-key", baseURL }));
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath, "generate", "--config", configPath, "--prompt", "  Use EXACT wording: teal cube / 1990s film.  ", "--output", outputPath,
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "success");
    assert.equal(result.exit_code, 0);
    assert.equal(result.error, null);
    assert.deepEqual(
      Object.keys(result).filter((key) => ["status", "command", "exit_code", "saved", "timing_ms", "error", "request_id"].includes(key)).sort(),
      ["command", "error", "exit_code", "request_id", "saved", "status", "timing_ms"],
    );
    assert.equal(result.saved[0].absolute_path, outputPath);
    assert.equal(typeof result.timing_ms.api, "number");
    assert.equal(typeof result.timing_ms.save, "number");
    assert.equal(typeof result.timing_ms.total, "number");
    assert.equal((await readFile(outputPath)).toString("base64"), fixturePngBase64);
  });
});

test("request-file executes generate and edit without image command-line arguments", async () => {
  const tempDir = await createTempDir();
  const skillRoot = path.join(tempDir, "skill root");
  const sourcePath = path.join(tempDir, "source image.png");
  const generateOutput = path.join(tempDir, "outputs with spaces", "generated.png");
  const editOutput = path.join(tempDir, "outputs with spaces", "edited.png");
  const generateStatus = path.join(tempDir, "statuses", "generate.json");
  const editStatus = path.join(tempDir, "statuses", "edit.json");
  const generateRequest = path.join(tempDir, "requests", "generate request.json");
  const editRequest = path.join(tempDir, "requests", "edit request.json");
  await mkdir(path.dirname(generateRequest), { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await writePng(sourcePath);

  const clientRequestIds = [];
  await withMockServer(async (req, res, body) => {
    assert.equal(req.headers.authorization, "Bearer request-file-key");
    assert.match(req.headers["x-niucodes-client-request-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    clientRequestIds.push(req.headers["x-niucodes-client-request-id"]);
    if (req.url === "/v1/images/generations") {
      const payload = JSON.parse(body);
      assert.equal(payload.prompt, '中文 prompt with spaces and "quotes"');
    } else {
      assert.equal(req.url, "/v1/images/edits");
      assert.match(req.headers["content-type"], /^multipart\/form-data/);
      assert.match(body.toString("latin1"), /keep the image and change the scarf/);
      assert.match(body.toString("latin1"), /name="stream"\r\n\r\ntrue/);
      assert.match(body.toString("latin1"), /name="partial_images"\r\n\r\n0/);
    }
    streamCompleted(res, req.url === "/v1/images/generations" ? "generate" : "edit");
  }, async (baseURL) => {
    await writeFile(path.join(skillRoot, "config.json"), JSON.stringify({ apiKey: "request-file-key", baseURL }));
    await writeFile(generateRequest, JSON.stringify({
      version: 1,
      command: "generate",
      statusFile: generateStatus,
      prompt: '中文 prompt with spaces and "quotes"',
      output: generateOutput,
      quality: "low",
      size: "1024x1024",
      overwrite: true,
    }));
    const generated = await execFileAsync(process.execPath, [scriptPath, "run", "--request-file", generateRequest], {
      env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot },
    });
    const generateResult = JSON.parse(generated.stdout);
    assert.equal(generated.stderr, "");
    assert.equal(generateResult.status, "success");
    assert.equal(generateResult.client_request_id, clientRequestIds[0]);
    assert.deepEqual(JSON.parse(await readFile(generateStatus, "utf8")), generateResult);
    assert.equal((await readFile(generateOutput)).toString("base64"), fixturePngBase64);

    await writeFile(editRequest, JSON.stringify({
      version: 1,
      command: "edit",
      statusFile: editStatus,
      prompt: "keep the image and change the scarf",
      image: [sourcePath],
      output: editOutput,
      quality: "low",
      size: "1024x1024",
      overwrite: true,
    }));
    const edited = await execFileAsync(process.execPath, [scriptPath, "run", "--request-file", editRequest], {
      env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot },
    });
    const editResult = JSON.parse(edited.stdout);
    assert.equal(edited.stderr, "");
    assert.equal(editResult.status, "success");
    assert.equal(editResult.client_request_id, clientRequestIds[1]);
    assert.deepEqual(JSON.parse(await readFile(editStatus, "utf8")), editResult);
    assert.equal((await readFile(editOutput)).toString("base64"), fixturePngBase64);
  });
});

test("connection loss after the API receives a request is reported as delivery unknown without retrying", async () => {
  const tempDir = await createTempDir();
  const skillRoot = path.join(tempDir, "skill root");
  const requestPath = path.join(tempDir, "request.json");
  const statusPath = path.join(tempDir, "status.json");
  const outputPath = path.join(tempDir, "output.png");
  await mkdir(skillRoot, { recursive: true });
  let receivedRequestCount = 0;
  let receivedClientRequestId;

  await withMockServer(async (req, res) => {
    receivedRequestCount += 1;
    receivedClientRequestId = req.headers["x-niucodes-client-request-id"];
    // The service has received the request but the response connection dies.
    // A retry here could create and bill for a duplicate image.
    res.destroy();
  }, async (baseURL) => {
    await writeFile(path.join(skillRoot, "config.json"), JSON.stringify({ apiKey: "connection-test-key", baseURL }));
    await writeFile(requestPath, JSON.stringify({
      version: 1,
      command: "generate",
      statusFile: statusPath,
      prompt: "connection should be reported safely",
      output: outputPath,
      overwrite: true,
    }));
    let failure;
    try {
      await execFileAsync(process.execPath, [scriptPath, "run", "--request-file", requestPath], {
        env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.equal(failure.code, 1);
    const result = JSON.parse(failure.stdout);
    assert.equal(result.status, "failed");
    assert.equal(result.exit_code, 1);
    assert.equal(result.stage, "request_delivery_unknown");
    assert.equal(result.error.kind, "request_delivery_unknown");
    assert.equal(result.client_request_id, receivedClientRequestId);
    assert.match(result.error.message, /Connection error/i);
    assert.equal(receivedRequestCount, 1);
    assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), result);
    assert.equal(await exists(outputPath), false);
  });
});

test("request-file failures return JSON without exposing credentials", async () => {
  const tempDir = await createTempDir();
  const requestPath = path.join(tempDir, "invalid request.json");
  const statusPath = path.join(tempDir, "invalid status.json");
  await writeFile(requestPath, JSON.stringify({
    version: 1,
    command: "generate",
    statusFile: statusPath,
    prompt: "test",
    output: path.join(tempDir, "output.png"),
    apiKey: "must-not-leak",
  }));
  let failure;
  try {
    await execFileAsync(process.execPath, [scriptPath, "run", "--request-file", requestPath]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  const result = JSON.parse(failure.stdout);
  assert.equal(failure.code, 1);
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /cannot contain apiKey/);
  assert.doesNotMatch(`${failure.stdout}${failure.stderr}`, /must-not-leak/);
  assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), result);
});

test("request-file protocol rejects old prompt flags as structured JSON", async () => {
  let failure;
  try {
    await execFileAsync(process.execPath, [scriptPath, "run", "--prompt", "old runner invocation"]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.code, 1);
  assert.equal(failure.stderr, "Usage: niucodes-image-gen run --request-stdin\n");
  const result = JSON.parse(failure.stdout);
  assert.equal(result.status, "failed");
  assert.equal(result.command, "run");
  assert.equal(result.exit_code, 1);
  assert.match(result.error.message, /request-stdin/);
});

test("request-file accepts a Windows UTF-8 BOM and keeps user data out of argv", async () => {
  const tempDir = await createTempDir();
  const skillRoot = path.join(tempDir, "skill root");
  const outputPath = path.join(tempDir, "output folder", "generated image.png");
  const statusPath = path.join(tempDir, "status folder", "generated status.json");
  const requestPath = path.join(tempDir, "request folder", "generate request.json");
  await mkdir(path.dirname(requestPath), { recursive: true });
  await mkdir(skillRoot, { recursive: true });

  await withMockServer(async (req, res, body) => {
    assert.equal(req.url, "/v1/images/generations");
    assert.equal(JSON.parse(body).prompt, '中文 prompt with spaces and "quotes"');
    streamCompleted(res, "generate");
  }, async (baseURL) => {
    await writeFile(path.join(skillRoot, "config.json"), JSON.stringify({ apiKey: "bom-test-key", baseURL }));
    await writeFile(requestPath, `\uFEFF${JSON.stringify({
      version: 1,
      command: "generate",
      statusFile: statusPath,
      prompt: '中文 prompt with spaces and "quotes"',
      output: outputPath,
      overwrite: true,
    })}`);
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, "run", "--request-file", requestPath], {
      env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot },
    });
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.status, "success");
    assert.equal((await readFile(outputPath)).toString("base64"), fixturePngBase64);
  });
});

test("request-stdin accepts a UTF-8 BOM, Chinese prompt, spaces, and quotes", async () => {
  const tempDir = await createTempDir();
  const skillRoot = path.join(tempDir, "skill root");
  const outputPath = path.join(tempDir, "output folder", "generated image.png");
  const statusPath = path.join(tempDir, "status folder", "generated status.json");
  await mkdir(skillRoot, { recursive: true });

  await withMockServer(async (req, res, body) => {
    assert.equal(req.url, "/v1/images/generations");
    const payload = JSON.parse(body);
    assert.equal(payload.prompt, '中文 prompt with spaces and "quotes"');
    assert.equal(payload.stream, true);
    assert.equal(payload.partial_images, 0);
    streamCompleted(res, "generate", { partialImages: 2 });
  }, async (baseURL) => {
    await writeFile(path.join(skillRoot, "config.json"), JSON.stringify({ apiKey: "stdin-test-key", baseURL }));
    const request = `\uFEFF${JSON.stringify({
      version: 1,
      command: "generate",
      statusFile: statusPath,
      prompt: '中文 prompt with spaces and "quotes"',
      output: outputPath,
      overwrite: true,
    })}`;
    const result = await runWithStdin(process.execPath, [scriptPath, "run", "--request-stdin"], request, {
      env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot },
    });
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "success");
    assert.equal(payload.timing_ms.stream_partial_events, 2);
    assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), payload);
    assert.equal((await readFile(outputPath)).toString("base64"), fixturePngBase64);
  });
});

test("an incomplete SSE stream fails once without retrying", async () => {
  const tempDir = await createTempDir();
  const skillRoot = path.join(tempDir, "skill root");
  const statusPath = path.join(tempDir, "status.json");
  const outputPath = path.join(tempDir, "output.png");
  await mkdir(skillRoot, { recursive: true });
  let requestCount = 0;

  await withMockServer(async (_req, res) => {
    requestCount += 1;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.end("data: [DONE]\\n\\n");
  }, async (baseURL) => {
    await writeFile(path.join(skillRoot, "config.json"), JSON.stringify({ apiKey: "incomplete-stream-key", baseURL }));
    let failure;
    try {
      await runWithStdin(process.execPath, [scriptPath, "run", "--request-stdin"], JSON.stringify({
        version: 1,
        command: "generate",
        statusFile: statusPath,
        prompt: "incomplete stream",
        output: outputPath,
        overwrite: true,
      }), { env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot } });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.equal(failure.code, 1);
    const result = JSON.parse(failure.stdout);
    assert.equal(result.status, "failed");
    assert.equal(result.stage, "request_or_save");
    assert.match(result.error.message, /ended without/i);
    assert.equal(requestCount, 1);
    assert.equal(await exists(outputPath), false);
    assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), result);
  });
});

test("a single completed image returns without waiting for the SSE socket to close", async () => {
  const tempDir = await createTempDir();
  const skillRoot = path.join(tempDir, "skill root");
  const statusPath = path.join(tempDir, "status.json");
  const outputPath = path.join(tempDir, "completed.png");
  await mkdir(skillRoot, { recursive: true });

  let clientClosed = false;
  await withMockServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.once("close", () => { clientClosed = true; });
    res.write(`data: ${JSON.stringify({ type: "image_generation.completed", b64_json: fixturePngBase64 })}\n\n`);
    // Deliberately keep the response open. A completed single-image request
    // must not wait for a proxy/server-side EOF before saving the result.
  }, async (baseURL) => {
    await writeFile(path.join(skillRoot, "config.json"), JSON.stringify({ apiKey: "completed-event-key", baseURL, timeoutMs: 5000 }));
    const startedAt = Date.now();
    const result = await runWithStdin(process.execPath, [scriptPath, "run", "--request-stdin"], JSON.stringify({
      version: 1,
      command: "generate",
      statusFile: statusPath,
      prompt: "finish on completed event",
      output: outputPath,
      overwrite: true,
    }), { env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot } });
    const elapsedMs = Date.now() - startedAt;
    const payload = JSON.parse(result.stdout);

    assert.equal(result.code, 0);
    assert.equal(payload.status, "success");
    assert.ok(elapsedMs < 2000, `completed event should return promptly, took ${elapsedMs}ms`);
    assert.equal(await exists(outputPath), true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(clientClosed, true);
  });
});

for (const command of ["generate", "edit"]) {
  test(`${command} saves a completed payload without an SSE delimiter or EOF`, async () => {
    const tempDir = await createTempDir();
    const skillRoot = path.join(tempDir, "skill root");
    const statusPath = path.join(tempDir, "status.json");
    const outputPath = path.join(tempDir, "output.png");
    const sourcePath = path.join(tempDir, "source.png");
    await mkdir(skillRoot, { recursive: true });
    if (command === "edit") await writePng(sourcePath);

    let clientClosed = false;
    await withMockServer(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.once("close", () => { clientClosed = true; });
      // Deliberately omit both LF and the blank SSE event terminator. This is
      // the proxy behavior that previously caused a full 10-minute timeout.
      res.write(`data: ${completedPayload(command)}`);
    }, async (baseURL) => {
      await writeFile(path.join(skillRoot, "config.json"), JSON.stringify({ apiKey: "unterminated-key", baseURL, timeoutMs: 5000 }));
      const request = {
        version: 1,
        command,
        statusFile: statusPath,
        prompt: "save immediately after complete JSON",
        output: outputPath,
        overwrite: true,
        ...(command === "edit" ? { image: [sourcePath] } : {}),
      };
      const startedAt = Date.now();
      const result = await runWithStdin(process.execPath, [scriptPath, "run", "--request-stdin"], JSON.stringify(request), {
        env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot },
      });
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "success");
      assert.equal(payload.timing_ms.stream_completed_frame_terminated, false);
      assert.ok(Date.now() - startedAt < 2000);
      assert.equal((await readFile(outputPath)).toString("base64"), fixturePngBase64);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(clientClosed, true);
    });
  });
}

test("generate waits for a completed JSON split across transport chunks, then returns before EOF", async () => {
  const tempDir = await createTempDir();
  const skillRoot = path.join(tempDir, "skill root");
  const statusPath = path.join(tempDir, "status.json");
  const outputPath = path.join(tempDir, "output.png");
  await mkdir(skillRoot, { recursive: true });

  await withMockServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    const payload = `data: ${completedPayload("generate")}`;
    const splitAt = Math.floor(payload.length / 2);
    res.write(payload.slice(0, splitAt));
    setTimeout(() => res.write(payload.slice(splitAt)), 40);
  }, async (baseURL) => {
    await writeFile(path.join(skillRoot, "config.json"), JSON.stringify({ apiKey: "split-key", baseURL, timeoutMs: 5000 }));
    const result = await runWithStdin(process.execPath, [scriptPath, "run", "--request-stdin"], JSON.stringify({
      version: 1,
      command: "generate",
      statusFile: statusPath,
      prompt: "split completed JSON",
      output: outputPath,
      overwrite: true,
    }), { env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot } });
    assert.equal(JSON.parse(result.stdout).status, "success");
    assert.equal((await readFile(outputPath)).toString("base64"), fixturePngBase64);
  });
});

test("stream timeout aborts the open connection and writes a final failure", async () => {
  const tempDir = await createTempDir();
  const skillRoot = path.join(tempDir, "skill root");
  const statusPath = path.join(tempDir, "status.json");
  const outputPath = path.join(tempDir, "output.png");
  let closed = false;
  await mkdir(skillRoot, { recursive: true });

  await withMockServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(`data: ${JSON.stringify({ type: "image_generation.partial_image", b64_json: fixturePngBase64, partial_image_index: 0 })}\\n\\n`);
    res.once("close", () => { closed = true; });
  }, async (baseURL) => {
    await writeFile(path.join(skillRoot, "config.json"), JSON.stringify({ apiKey: "timeout-stream-key", baseURL, timeoutMs: 1000 }));
    const startedAt = Date.now();
    let failure;
    try {
      await runWithStdin(process.execPath, [scriptPath, "run", "--request-stdin"], JSON.stringify({
        version: 1,
        command: "generate",
        statusFile: statusPath,
        prompt: "timeout stream",
        output: outputPath,
        overwrite: true,
      }), { env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot } });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.ok(Date.now() - startedAt < 4000);
    const result = JSON.parse(failure.stdout);
    assert.equal(result.status, "failed");
    assert.match(result.error.message, /timed out after 1000ms/i);
    assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), result);
  });
  assert.equal(closed, true);
});

test("SIGTERM closes an active stream and returns one final structured failure", {
  // Windows terminates a child process for SIGTERM instead of delivering a
  // catchable POSIX signal, so this lifecycle contract is not observable there.
  skip: process.platform === "win32",
}, async () => {
  const tempDir = await createTempDir();
  const skillRoot = path.join(tempDir, "skill root");
  const statusPath = path.join(tempDir, "status.json");
  const outputPath = path.join(tempDir, "output.png");
  await mkdir(skillRoot, { recursive: true });
  let notifyRequestStarted;
  const requestStarted = new Promise((resolve) => { notifyRequestStarted = resolve; });
  let closed = false;

  await withMockServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(`data: ${JSON.stringify({ type: "image_generation.partial_image", b64_json: fixturePngBase64, partial_image_index: 0 })}\n\n`);
    res.once("close", () => { closed = true; });
    notifyRequestStarted();
  }, async (baseURL) => {
    await writeFile(path.join(skillRoot, "config.json"), JSON.stringify({ apiKey: "signal-stream-key", baseURL, timeoutMs: 10000 }));
    const child = spawn(process.execPath, [scriptPath, "run", "--request-stdin"], {
      env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.end(JSON.stringify({
      version: 1,
      command: "generate",
      statusFile: statusPath,
      prompt: "cancel stream",
      output: outputPath,
      overwrite: true,
    }));
    await requestStarted;
    child.kill("SIGTERM");
    const processResult = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(processResult.code, 1);
    assert.equal(processResult.signal, null);
    assert.equal(Buffer.concat(stderr).toString("utf8"), "Image request cancelled by SIGTERM.\n");
    const payload = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    assert.equal(payload.status, "failed");
    assert.equal(payload.stage, "request_or_save");
    assert.match(payload.error.message, /cancelled by SIGTERM/i);
    assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), payload);
  });
  assert.equal(closed, true);
});

test("generate publishes a running then successful atomic status after a delayed API response", async () => {
  const tempDir = await createTempDir();
  const configPath = path.join(tempDir, "config.json");
  const outputPath = path.join(tempDir, "generated.png");
  const statusPath = path.join(tempDir, "generated.status.json");
  let notifyRequestStarted;
  const requestStarted = new Promise((resolve) => { notifyRequestStarted = resolve; });
  await withMockServer(async (_req, res) => {
    notifyRequestStarted();
    await new Promise((resolve) => setTimeout(resolve, 100));
    streamCompleted(res, "generate");
  }, async (baseURL) => {
    await writeFile(configPath, JSON.stringify({ apiKey: "config-key", baseURL }));
    const command = execFileAsync(process.execPath, [
      scriptPath, "generate", "--config", configPath, "--prompt", "delayed image", "--output", outputPath, "--status-file", statusPath,
    ]);
    await requestStarted;
    const running = JSON.parse(await readFile(statusPath, "utf8"));
    assert.equal(running.status, "running");
    assert.equal(running.command, "generate");
    const { stdout } = await command;
    const result = JSON.parse(stdout);
    const complete = JSON.parse(await readFile(statusPath, "utf8"));
    assert.equal(complete.status, "success");
    assert.equal(complete.exit_code, 0);
    assert.deepEqual(complete.saved.map((item) => item.absolute_path), [outputPath]);
    assert.deepEqual(complete.timing_ms, result.timing_ms);
  });
});

test("edit sends the configured HTTP request as multipart", async () => {
  const tempDir = await createTempDir();
  const configPath = path.join(tempDir, "config.json");
  const imagePath = path.join(tempDir, "source.png");
  const outputPath = path.join(tempDir, "edited.webp");
  await writePng(imagePath);
  await withMockServer(async (req, res, body) => {
    assert.equal(req.url, "/v1/images/edits");
    assert.equal(req.headers.authorization, "Bearer edit-key");
    assert.match(req.headers["content-type"], /^multipart\/form-data/);
    assert.match(body.toString("latin1"), /replace subject with a polished chrome vase/);
    assert.match(body.toString("latin1"), /name="stream"\r\n\r\ntrue/);
    assert.match(body.toString("latin1"), /name="partial_images"\r\n\r\n0/);
    streamCompleted(res, "edit");
  }, async (baseURL) => {
    await writeFile(configPath, JSON.stringify({ apiKey: "edit-key", baseURL, model: "gpt-image-1", quality: "low", outputFormat: "webp" }));
    const statusPath = path.join(tempDir, "edited.status.json");
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath, "edit", "--config", configPath, "--image", imagePath, "--prompt", "replace subject with a polished chrome vase", "--output", outputPath, "--status-file", statusPath,
    ]);
    const result = JSON.parse(stdout);
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    assert.equal(status.status, "success");
    assert.equal(status.command, "edit");
    assert.equal(status.exit_code, 0);
    assert.equal(typeof result.timing_ms.input_prepare, "number");
    assert.equal((await readFile(outputPath)).toString("base64"), fixturePngBase64);
  });
});

test("failed edit records a final status without exposing credentials", async () => {
  const tempDir = await createTempDir();
  const configPath = path.join(tempDir, "config.json");
  const imagePath = path.join(tempDir, "source.png");
  const outputPath = path.join(tempDir, "edited.png");
  const statusPath = path.join(tempDir, "edited.status.json");
  await writePng(imagePath);
  await withMockServer(async (_req, res) => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "mock edit failed" } }));
  }, async (baseURL) => {
    await writeFile(configPath, JSON.stringify({ apiKey: "sensitive-key", baseURL }));
    await assert.rejects(
      execFileAsync(process.execPath, [
        scriptPath, "edit", "--config", configPath, "--image", imagePath, "--prompt", "fail", "--output", outputPath, "--status-file", statusPath,
      ]),
    );
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    assert.equal(status.status, "failed");
    assert.equal(status.command, "edit");
    assert.equal(status.exit_code, 1);
    assert.equal(typeof status.error.message, "string");
    assert.doesNotMatch(JSON.stringify(status), /sensitive-key/);
  });
});

test("config defaults are retained and API key flags are rejected", async () => {
  const tempDir = await createTempDir();
  const configPath = path.join(tempDir, "config.json");
  await writeFile(configPath, JSON.stringify({ apiKey: "config-key" }));
  const invocation = await resolveInvocation("edit", {
    config: configPath,
    prompt: "add a scarf",
    output: path.join(tempDir, "edited.png"),
    image: [path.join(repoRoot, "package.json")],
  }, { cwd: repoRoot });
  assert.equal(invocation.apiKey, "config-key");
  assert.equal(invocation.size, DEFAULT_EDIT_SIZE);
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "generate", "--config", configPath, "--api-key", "ignored", "--prompt", "a test"]),
    /--api-key is not supported/,
  );
});

test("proxyUrl is read only from config.json and validated before a request", async () => {
  const tempDir = await createTempDir();
  const configPath = path.join(tempDir, "config.json");
  await writeFile(configPath, JSON.stringify({ apiKey: "config-key", proxyUrl: "http://proxy.example.test:8080" }));
  const invocation = await resolveInvocation("generate", {
    config: configPath,
    prompt: "a test",
    output: path.join(tempDir, "generated.png"),
    image: [],
  }, { cwd: repoRoot });
  assert.equal(invocation.proxyUrl, "http://proxy.example.test:8080/");

  await writeFile(configPath, JSON.stringify({ apiKey: "config-key", proxyUrl: "socks5://proxy.example.test" }));
  await assert.rejects(
    resolveInvocation("generate", {
      config: configPath,
      prompt: "a test",
      output: path.join(tempDir, "generated.png"),
      image: [],
    }, { cwd: repoRoot }),
    /proxyUrl must be a valid http or https URL/,
  );
});

test("configured HTTP proxy carries a generate request and closes its dispatcher", async () => {
  const tempDir = await createTempDir();
  const skillRoot = path.join(tempDir, "skill root");
  const requestPath = path.join(tempDir, "request.json");
  const statusPath = path.join(tempDir, "status.json");
  const outputPath = path.join(tempDir, "output.png");
  await mkdir(skillRoot, { recursive: true });

  await withMockServer(async (request, response) => {
    assert.equal(request.url, "/v1/images/generations");
    streamCompleted(response, "generate");
  }, async (baseURL) => {
    await withHttpProxy(async (proxyUrl) => {
      await writeFile(path.join(skillRoot, "config.json"), JSON.stringify({ apiKey: "proxy-test-key", baseURL, proxyUrl }));
      await writeFile(requestPath, JSON.stringify({
        version: 1,
        command: "generate",
        statusFile: statusPath,
        prompt: "proxy request",
        output: outputPath,
        overwrite: true,
      }));
      const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, "run", "--request-file", requestPath], {
        env: { ...process.env, NIUCODES_IMAGE_GEN_SKILL_DIR: skillRoot },
      });
      assert.equal(stderr, "");
      assert.equal(JSON.parse(stdout).status, "success");
      assert.equal((await readFile(outputPath)).toString("base64"), fixturePngBase64);
    });
  });
});

test("requires an explicit output location outside the skill directory", async () => {
  const tempDir = await createTempDir();
  const configPath = path.join(tempDir, "config.json");
  await writeFile(configPath, JSON.stringify({ apiKey: "config-key" }));

  await assert.rejects(
    resolveInvocation("generate", { config: configPath, prompt: "a test", image: [] }, { cwd: repoRoot }),
    /Missing output directory/,
  );
  await assert.rejects(
    resolveInvocation("generate", {
      config: configPath,
      prompt: "a test",
      output: path.join(repoRoot, "image-outputs"),
      image: [],
    }, { cwd: repoRoot }),
    /outside the skill directory/,
  );

  const invocation = await resolveInvocation("generate", {
    config: configPath,
    prompt: "a test",
    output: path.join(tempDir, "images"),
    image: [],
  }, { cwd: repoRoot });
  assert.equal(invocation.output, path.join(tempDir, "images"));
});
