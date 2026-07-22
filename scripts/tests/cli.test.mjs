import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
const windowsRunnerPath = path.join(repoRoot, "scripts", "invoke-imagegen.ps1");
const macosRunnerPath = path.join(repoRoot, "scripts", "invoke-imagegen.sh");
const macosArm64BinaryPath = path.join(repoRoot, "bin", "niucodes-image-gen-macos-arm64");
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

test("skill uses its bundled local runner and does not prescribe MCP", async () => {
  const skill = await readFile(path.join(repoRoot, "SKILL.md"), "utf8");
  assert.match(skill, /bundled local runner/i);
  assert.match(skill, /invoke-imagegen\.sh/);
  assert.match(skill, /invoke-imagegen\.ps1/);
  assert.match(skill, /timeout-seconds 600/i);
  assert.match(skill, /do not interrupt the local process/i);
  assert.doesNotMatch(skill, /imagegen_generate|imagegen_edit|native MCP/i);
  assert.doesNotMatch(await readFile(scriptPath, "utf8"), /runMcpServer|mcp-server/);
});

test("Windows installation entrypoint runs the bundled executable in install mode", async () => {
  const installer = await readFile(path.join(repoRoot, "scripts", "install-windows.cmd"), "utf8");
  assert.match(installer, /niucodes-image-gen-win-x64\.exe/i);
  assert.match(installer, /"%EXECUTABLE%" install/i);
  assert.match(installer, /Restart Codex Desktop/i);
});

test("Windows runner atomically replaces status files without File.Replace", async () => {
  const runner = await readFile(windowsRunnerPath, "utf8");
  assert.match(runner, /MoveFileEx/);
  assert.match(runner, /MOVEFILE_REPLACE_EXISTING/);
  assert.doesNotMatch(runner, /\[System\.IO\.File\]::Replace/);
  assert.match(runner, /function Normalize-ImageArguments/);
  assert.match(runner, /"-prompt"\s*=\s*"--prompt"/);
  assert.match(runner, /"-output"\s*=\s*"--output"/);
  assert.match(runner, /\[string\]\$Prompt/);
  assert.match(runner, /Add-ImageOption \$normalizedImageArguments "prompt" \$Prompt/);
  assert.match(runner, /\$null -eq \$Arguments -or \$Arguments\.Count -eq 0/);
});

test("legacy MCP config removal preserves unrelated server configuration", () => {
  const initial = '[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.niucodes_image_gen]\ncommand = "old"\nargs = ["mcp"]\n';
  const updated = removeLegacyMcpServerConfig(initial);
  assert.match(updated, /\[mcp_servers\.other\]/);
  assert.doesNotMatch(updated, /\[mcp_servers\.niucodes_image_gen\]/);
});

test("installer copies runners, preserves API config, and removes legacy MCP config", async () => {
  const tempDir = await createTempDir();
  const sourceRoot = path.join(tempDir, "source skill");
  const installDir = path.join(tempDir, "installed skill");
  const configPath = path.join(tempDir, "codex", "config.toml");
  await mkdir(path.join(sourceRoot, "bin"), { recursive: true });
  await mkdir(path.join(sourceRoot, "scripts"), { recursive: true });
  await writeFile(path.join(sourceRoot, "SKILL.md"), "---\nname: niucodes-image-gen\ndescription: test\n---\n");
  await writeFile(path.join(sourceRoot, "config.json"), '{"apiKey":"template-key"}');
  await writeFile(path.join(sourceRoot, "bin", "niucodes-image-gen-macos-arm64"), "binary");
  await writeFile(path.join(sourceRoot, "scripts", "invoke-imagegen.sh"), "#!/bin/bash\n");
  await writeFile(path.join(sourceRoot, "scripts", "invoke-imagegen.ps1"), "# runner\n");
  await mkdir(installDir, { recursive: true });
  await writeFile(path.join(installDir, "config.json"), '{"apiKey":"preserved-key"}');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.niucodes_image_gen]\ncommand = "old"\nargs = ["mcp"]\n');

  const result = await installSkill({ packageRoot: sourceRoot, installDir, configPath, platform: "darwin", arch: "arm64" });
  assert.equal(result.status, "success");
  assert.equal(result.executable, path.join(installDir, "bin", "niucodes-image-gen-macos-arm64"));
  assert.equal(result.runner, path.join(installDir, "scripts", "invoke-imagegen.sh"));
  assert.equal(result.removed_legacy_mcp_config, true);
  assert.equal(await readFile(path.join(installDir, "config.json"), "utf8"), '{"apiKey":"preserved-key"}');
  const codexConfig = await readFile(configPath, "utf8");
  assert.match(codexConfig, /\[mcp_servers\.other\]/);
  assert.doesNotMatch(codexConfig, /\[mcp_servers\.niucodes_image_gen\]/);
});

test("Apple Silicon installer deploys the runner and removes legacy MCP config", { skip: process.platform !== "darwin" }, async () => {
  const tempDir = await createTempDir();
  const installDir = path.join(tempDir, "installed skill");
  const configPath = path.join(tempDir, "codex config", "config.toml");
  await mkdir(installDir, { recursive: true });
  await writeFile(path.join(installDir, "config.json"), '{"apiKey":"preserved"}');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '[mcp_servers.niucodes_image_gen]\ncommand = "old"\nargs = ["mcp"]\n');

  const { stdout, stderr } = await execFileAsync(macosArm64BinaryPath, [
    "install", "--install-dir", installDir, "--config-path", configPath,
  ]);
  const result = JSON.parse(stdout);
  assert.equal(stderr, "");
  assert.equal(result.status, "success");
  assert.equal(result.runner, path.join(installDir, "scripts", "invoke-imagegen.sh"));
  assert.match(await readFile(result.runner, "utf8"), /TIMEOUT_SECONDS=600/);
  assert.equal(await readFile(path.join(installDir, "config.json"), "utf8"), '{"apiKey":"preserved"}');
  assert.doesNotMatch(await readFile(configPath, "utf8"), /\[mcp_servers\.niucodes_image_gen\]/);
});

test("macOS runner waits locally and emits one final status JSON", { skip: process.platform !== "darwin" }, async () => {
  const tempDir = await createTempDir();
  const statusPath = path.join(tempDir, "status with spaces.json");
  const mockExecutable = path.join(tempDir, "mock image binary.sh");
  await writeFile(mockExecutable, `#!/bin/bash
status_file=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--status-file" ]; then status_file="$2"; shift 2; else shift; fi
done
printf '%s\\n' '{"status":"running","command":"generate","exit_code":null,"saved":[],"timing_ms":{},"error":null,"request_id":null}' > "$status_file"
sleep 0.05
printf '%s\\n' '{"status":"success","command":"generate","exit_code":0,"saved":[{"absolute_path":"/tmp/output image.png"}],"timing_ms":{"input_prepare":0,"api":50,"save":0,"total":50},"error":null,"request_id":"mock-request"}' > "$status_file"
printf '%s\\n' 'child stdout must not be forwarded'
`);
  await (await import("node:fs/promises")).chmod(mockExecutable, 0o755);

  const { stdout, stderr } = await execFileAsync("/bin/bash", [
    macosRunnerPath,
    "generate",
    "--status-file", statusPath,
    "--timeout-seconds", "5",
    "--executable-path", mockExecutable,
    "--prompt", "中文 prompt with spaces and \\\"quotes\\\"",
    "--output", path.join(tempDir, "output image.png"),
  ]);
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.status, "success");
  assert.equal(result.exit_code, 0);
  assert.equal(result.request_id, "mock-request");
  assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), result);
  assert.doesNotMatch(stdout, /child stdout/);
});

test("macOS runner preserves failed and timeout result contracts", { skip: process.platform !== "darwin" }, async () => {
  const tempDir = await createTempDir();
  const failedStatusPath = path.join(tempDir, "failed.status.json");
  const failedExecutable = path.join(tempDir, "failed binary.sh");
  await writeFile(failedExecutable, `#!/bin/bash
while [ "$1" != "--status-file" ]; do shift; done
printf '%s\\n' '{"status":"failed","command":"edit","exit_code":1,"saved":[],"timing_ms":{"total":7},"error":{"message":"mock failure"},"request_id":null}' > "$2"
exit 1
`);
  await (await import("node:fs/promises")).chmod(failedExecutable, 0o755);

  await assert.rejects(
    execFileAsync("/bin/bash", [macosRunnerPath, "edit", "--status-file", failedStatusPath, "--executable-path", failedExecutable]),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(result.status, "failed");
      assert.equal(result.error.message, "mock failure", JSON.stringify(result));
      return true;
    },
  );

  const timeoutStatusPath = path.join(tempDir, "timeout.status.json");
  const timeoutExecutable = path.join(tempDir, "slow binary.sh");
  await writeFile(timeoutExecutable, `#!/bin/bash
while [ "$1" != "--status-file" ]; do shift; done
printf '%s\\n' '{"status":"running","command":"generate","exit_code":null,"saved":[],"timing_ms":{},"error":null,"request_id":null}' > "$2"
sleep 10
`);
  await (await import("node:fs/promises")).chmod(timeoutExecutable, 0o755);

  let timeoutError;
  try {
    await execFileAsync("/bin/bash", [macosRunnerPath, "generate", "--status-file", timeoutStatusPath, "--timeout-seconds", "1", "--executable-path", timeoutExecutable]);
  } catch (error) {
    timeoutError = error;
  }
  assert.ok(timeoutError);
  const timeoutResult = JSON.parse(timeoutError.stdout);
  assert.equal(timeoutError.code, 124);
  assert.equal(timeoutResult.status, "failed");
  assert.equal(timeoutResult.exit_code, 124);
  assert.match(timeoutResult.error.message, /Timed out/);
  assert.deepEqual(JSON.parse(await readFile(timeoutStatusPath, "utf8")), timeoutResult);
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

test("Apple Silicon executable performs an edit upload end to end", { skip: process.platform !== "darwin" }, async () => {
  const tempDir = await createTempDir();
  const configPath = path.join(tempDir, "config.json");
  const imagePath = path.join(tempDir, "source.png");
  const outputPath = path.join(tempDir, "edited.png");
  await writePng(imagePath);

  await withMockServer(async (req, res, body) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/images/edits");
    assert.equal(req.headers.authorization, "Bearer binary-test-key");
    assert.match(req.headers["content-type"], /^multipart\/form-data/);
    assert.match(body.toString("latin1"), /make the vase blue/);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ b64_json: fixturePngBase64 }] }));
  }, async (baseURL) => {
    await writeFile(configPath, JSON.stringify({ apiKey: "binary-test-key", baseURL }));
    const { stdout, stderr } = await execFileAsync(macosArm64BinaryPath, [
      "edit", "--config", configPath, "--image", imagePath, "--prompt", "make the vase blue", "--output", outputPath,
    ]);
    assert.equal(stderr, "");
    assert.equal(JSON.parse(stdout).status, "success");
    assert.equal((await readFile(outputPath)).toString("base64"), fixturePngBase64);
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
