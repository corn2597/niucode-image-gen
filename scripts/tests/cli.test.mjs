import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
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

test("skill uses a root config file and has no stored key or key setter flow", async () => {
  const skill = await readFile(path.join(repoRoot, "SKILL.md"), "utf8");
  const config = JSON.parse(await readFile(path.join(repoRoot, "config.json"), "utf8"));
  assert.equal(resolveConfigPath(undefined), path.join(repoRoot, "config.json"));
  assert.equal(config.apiKey, "");
  assert.match(skill, /only API credential source/i);
  assert.doesNotMatch(skill, /set-skill-api-key|OPENAI_API_KEY|API_KEY:/i);
});

test("skill uses its bundled native request-file entrypoint and does not prescribe MCP", async () => {
  const skill = await readFile(path.join(repoRoot, "SKILL.md"), "utf8");
  assert.match(skill, /bundled native executable/i);
  assert.match(skill, /run --request-file/i);
  assert.match(skill, /do not interrupt the native executable/i);
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
  await mkdir(path.join(installDir, "scripts"), { recursive: true });
  await writeFile(path.join(installDir, "scripts", "invoke-imagegen.ps1"), "legacy runner");
  await writeFile(path.join(installDir, "scripts", "invoke-imagegen.sh"), "legacy runner");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.niucodes_image_gen]\ncommand = "old"\nargs = ["mcp"]\n');

  const result = await installSkill({ packageRoot: sourceRoot, installDir, configPath, platform: "darwin", arch: "arm64" });
  assert.equal(result.status, "success");
  assert.equal(result.executable, path.join(installDir, "bin", "niucodes-image-gen-macos-arm64"));
  assert.equal(result.protocol, "request-file-v1");
  assert.equal(result.removed_legacy_mcp_config, true);
  assert.equal(await readFile(path.join(installDir, "config.json"), "utf8"), '{"apiKey":"preserved-key"}');
  assert.equal(await exists(path.join(installDir, "scripts", "invoke-imagegen.ps1")), false);
  assert.equal(await exists(path.join(installDir, "scripts", "invoke-imagegen.sh")), false);
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
  assert.equal(result.protocol, "request-file-v1");
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
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ b64_json: fixturePngBase64 }] }));
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

  await withMockServer(async (req, res, body) => {
    assert.equal(req.headers.authorization, "Bearer request-file-key");
    if (req.url === "/v1/images/generations") {
      const payload = JSON.parse(body);
      assert.equal(payload.prompt, '中文 prompt with spaces and "quotes"');
    } else {
      assert.equal(req.url, "/v1/images/edits");
      assert.match(req.headers["content-type"], /^multipart\/form-data/);
      assert.match(body.toString("latin1"), /keep the image and change the scarf/);
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ b64_json: fixturePngBase64 }] }));
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
    assert.deepEqual(JSON.parse(await readFile(editStatus, "utf8")), editResult);
    assert.equal((await readFile(editOutput)).toString("base64"), fixturePngBase64);
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
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ b64_json: fixturePngBase64 }] }));
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
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ b64_json: fixturePngBase64 }] }));
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

test("edit sends the configured SDK request as multipart", async () => {
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
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ b64_json: fixturePngBase64 }] }));
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
