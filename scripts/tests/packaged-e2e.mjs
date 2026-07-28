import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixturePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s4Xv2QAAAAASUVORK5CYII=";

function readPackageRoot(argv) {
  if (argv.length !== 2 || argv[0] !== "--package-root") {
    throw new Error("Usage: node packaged-e2e.mjs --package-root <unpacked-release-directory>");
  }
  return path.resolve(argv[1]);
}

function binaryName() {
  if (process.platform === "win32" && process.arch === "x64") return "niucodes-image-gen-win-x64.exe";
  if (process.platform === "darwin" && process.arch === "arm64") return "niucodes-image-gen-macos-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "niucodes-image-gen-macos-x64";
  throw new Error(`Unsupported E2E platform: ${process.platform}-${process.arch}`);
}

function executablePath(packageRoot) {
  return process.env.NIUCODES_IMAGE_GEN_E2E_EXECUTABLE
    ? path.resolve(process.env.NIUCODES_IMAGE_GEN_E2E_EXECUTABLE)
    : path.join(packageRoot, "bin", binaryName());
}

function nativeCommand(executable, args) {
  if (process.env.NIUCODES_IMAGE_GEN_E2E_ROSETTA === "1") {
    return { file: "arch", args: ["-x86_64", executable, ...args] };
  }
  return { file: executable, args };
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runNativeWithStdin(executable, requestJson) {
  const command = nativeCommand(executable, ["run", "--request-stdin"]);
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
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
      else reject(Object.assign(new Error(`Native process exited with ${code ?? signal}`), result));
    });
    child.stdin.end(requestJson, "utf8");
  });
}

async function runNativeViaPowerShell(executable, requestJson) {
  if (process.platform !== "win32") return runNativeWithStdin(executable, requestJson);

  // The encoded script preserves Chinese JSON and verifies the exact native
  // stdin boundary used by Windows Codex, without any .ps1 runner.
  const script = [
    `$exe = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(executable, "utf8").toString("base64")}'))`,
    `$request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(requestJson, "utf8").toString("base64")}'))`,
    "$utf8 = [System.Text.UTF8Encoding]::new($false)",
    "$previousOutputEncoding = $OutputEncoding",
    "$exitCode = 1",
    "try {",
    "  $OutputEncoding = $utf8",
    "  [Console]::OutputEncoding = $utf8",
    "  $request | & $exe run --request-stdin",
    "  $exitCode = $LASTEXITCODE",
    "} finally {",
    "  $OutputEncoding = $previousOutputEncoding",
    "}",
    "exit $exitCode",
  ].join("\n");
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  return execFileAsync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
    encoding: "utf8",
    windowsHide: true,
  });
}

async function findPowerShellScripts(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...await findPowerShellScripts(entryPath));
    } else if (entry.name.toLowerCase().endsWith(".ps1")) {
      matches.push(entryPath);
    }
  }
  return matches;
}

async function runNativeInstall(executable, installDir, configPath) {
  const command = nativeCommand(executable, [
    "install",
    "--install-dir", installDir,
    "--config-path", configPath,
  ]);
  return execFileAsync(command.file, command.args, {
    encoding: "utf8",
    windowsHide: true,
  });
}

async function withMockImagesApi(handler, run) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => handler(request, response, Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function streamCompleted(response, command) {
  const prefix = command === "generate" ? "image_generation" : "image_edit";
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "x-request-id": `packaged-${prefix}-request`,
  });
  // Keep the transport open and deliberately omit both LF and the blank SSE
  // delimiter. Packaged runners must save once the complete JSON/Base64 bytes
  // arrive instead of waiting for a proxy to close the response.
  response.write(`data: ${JSON.stringify({ type: `${prefix}.completed`, b64_json: fixturePngBase64 })}`);
}

async function assertSuccessfulRequest(executable, requestJson, statusFile, outputFile, runner = runNativeWithStdin) {
  const { stdout, stderr } = await runner(executable, requestJson);
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.status, "success");
  assert.equal(result.exit_code, 0);
  assert.deepEqual(JSON.parse(await readFile(statusFile, "utf8")), result);
  assert.equal((await readFile(outputFile)).toString("base64"), fixturePngBase64);
}

const packageRoot = readPackageRoot(process.argv.slice(2));
const executable = executablePath(packageRoot);
if (!(await exists(executable))) throw new Error(`Packaged executable was not found: ${executable}`);
assert.deepEqual(await findPowerShellScripts(packageRoot), [], "Release package must not contain PowerShell scripts.");
if (await exists(path.join(packageRoot, "scripts", "invoke-imagegen.sh"))) {
  throw new Error("Release package must not contain the legacy shell runner.");
}

const testRoot = await mkdtemp(path.join(tmpdir(), "niucodes imagegen packaged E2E 中文 "));
const sourceImage = path.join(testRoot, "输入图片 source.png");
const generatedImage = path.join(testRoot, "output folder", "generated image.png");
const editedImage = path.join(testRoot, "output folder", "edited image.png");
const generateStatus = path.join(testRoot, "status folder", "generate status.json");
const editStatus = path.join(testRoot, "status folder", "edit status.json");
const generateRequest = path.join(testRoot, "request folder", "generate request.json");
const editRequest = path.join(testRoot, "request folder", "edit request.json");
const installedSkill = path.join(testRoot, "installed skill 中文");
const installedConfigPath = path.join(testRoot, "codex config", "config.toml");
const installedOutput = path.join(testRoot, "installed output", "generated after install.png");
const installedStatus = path.join(testRoot, "installed status", "generated after install.json");
const installedRequest = path.join(testRoot, "installed request", "request.json");
await mkdir(path.dirname(generateRequest), { recursive: true });
await mkdir(path.join(installedSkill, "scripts"), { recursive: true });
await mkdir(path.join(installedSkill, "bin"), { recursive: true });
await mkdir(path.dirname(installedConfigPath), { recursive: true });
await writeFile(sourceImage, Buffer.from(fixturePngBase64, "base64"));
await writeFile(path.join(installedSkill, "config.json"), JSON.stringify({ apiKey: "packaged-e2e-key", baseURL: "will-be-replaced" }));
await writeFile(path.join(installedSkill, "scripts", "invoke-imagegen.ps1"), "legacy runner");
await writeFile(path.join(installedSkill, "scripts", "invoke-imagegen.sh"), "legacy runner");
await writeFile(path.join(installedSkill, "scripts", "other-legacy-runner.ps1"), "legacy runner");
await writeFile(path.join(installedSkill, "bin", "obsolete-installer.exe"), "legacy binary");
await writeFile(installedConfigPath, '[mcp_servers.niucodes_image_gen]\ncommand = "legacy"\n');

let requestCount = 0;
await withMockImagesApi(async (request, response, body) => {
  requestCount += 1;
  assert.equal(request.headers.authorization, "Bearer packaged-e2e-key");
  assert.match(request.headers["x-niucodes-client-request-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  if (request.url === "/v1/images/generations") {
    const payload = JSON.parse(body);
    assert.equal(payload.stream, true);
    assert.equal(payload.partial_images, 0);
    assert.ok([
      '中文生成 prompt with spaces and "quotes"',
      'installed package prompt with spaces and "quotes"',
    ].includes(payload.prompt));
  } else {
    assert.equal(request.url, "/v1/images/edits");
    assert.match(request.headers["content-type"], /^multipart\/form-data/);
    assert.match(body.toString("latin1"), /keep composition and change scarf to blue/);
    assert.match(body.toString("latin1"), /name="stream"\r\n\r\ntrue/);
    assert.match(body.toString("latin1"), /name="partial_images"\r\n\r\n0/);
  }
  streamCompleted(response, request.url === "/v1/images/generations" ? "generate" : "edit");
}, async (baseURL) => {
  await writeFile(path.join(packageRoot, "config.json"), JSON.stringify({ apiKey: "packaged-e2e-key", baseURL }));
  await writeFile(generateRequest, `\uFEFF${JSON.stringify({
    version: 1,
    command: "generate",
    statusFile: generateStatus,
    prompt: '中文生成 prompt with spaces and "quotes"',
    output: generatedImage,
    quality: "low",
    size: "1024x1024",
    overwrite: true,
  })}`);
  await assertSuccessfulRequest(executable, await readFile(generateRequest, "utf8"), generateStatus, generatedImage);

  await writeFile(editRequest, JSON.stringify({
    version: 1,
    command: "edit",
    statusFile: editStatus,
    prompt: "keep composition and change scarf to blue",
    image: [sourceImage],
    output: editedImage,
    quality: "low",
    size: "1024x1024",
    overwrite: true,
  }));
  await assertSuccessfulRequest(executable, await readFile(editRequest, "utf8"), editStatus, editedImage);

  if (process.platform === "win32") {
    await assertSuccessfulRequest(executable, await readFile(generateRequest, "utf8"), generateStatus, generatedImage, runNativeViaPowerShell);
    await assertSuccessfulRequest(executable, await readFile(editRequest, "utf8"), editStatus, editedImage, runNativeViaPowerShell);
  }

  const installResult = JSON.parse((await runNativeInstall(executable, installedSkill, installedConfigPath)).stdout);
  assert.equal(installResult.status, "success");
  assert.equal(installResult.protocol, "stream-stdin-v2");
  assert.equal(await exists(path.join(installedSkill, "scripts", "invoke-imagegen.ps1")), false);
  assert.equal(await exists(path.join(installedSkill, "scripts", "invoke-imagegen.sh")), false);
  assert.equal(await exists(path.join(installedSkill, "scripts")), false);
  assert.equal(await exists(path.join(installedSkill, "bin", "obsolete-installer.exe")), false);
  assert.doesNotMatch(await readFile(installedConfigPath, "utf8"), /niucodes_image_gen/);

  await mkdir(path.dirname(installedRequest), { recursive: true });
  await writeFile(path.join(installedSkill, "config.json"), JSON.stringify({ apiKey: "packaged-e2e-key", baseURL }));
  await writeFile(installedRequest, JSON.stringify({
    version: 1,
    command: "generate",
    statusFile: installedStatus,
    prompt: 'installed package prompt with spaces and "quotes"',
    output: installedOutput,
    quality: "low",
    size: "1024x1024",
    overwrite: true,
  }));
  await assertSuccessfulRequest(path.join(installedSkill, "bin", path.basename(executable)), await readFile(installedRequest, "utf8"), installedStatus, installedOutput);
});

assert.equal(requestCount, process.platform === "win32" ? 5 : 3);
process.stdout.write(`${JSON.stringify({ status: "success", platform: `${process.platform}-${process.arch}`, package_root: packageRoot, generate: generatedImage, edit: editedImage })}\n`);
