import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
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

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runNative(executable, requestFile) {
  return execFileAsync(executable, ["run", "--request-file", requestFile], {
    encoding: "utf8",
    windowsHide: true,
  });
}

async function runNativeViaPowerShell(executable, requestFile) {
  if (process.platform !== "win32") return runNative(executable, requestFile);

  // Encode paths instead of interpolating them into PowerShell source. This
  // verifies the user-facing `& exe run --request-file <path>` boundary with
  // Chinese and space-containing paths while keeping request content off argv.
  const script = [
    `$exe = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(executable, "utf8").toString("base64")}'))`,
    `$request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(requestFile, "utf8").toString("base64")}'))`,
    "& $exe run --request-file $request",
    "exit $LASTEXITCODE",
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
  return execFileAsync(executable, [
    "install",
    "--install-dir", installDir,
    "--config-path", configPath,
  ], {
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

async function assertSuccessfulRequest(executable, requestFile, statusFile, outputFile, runner = runNative) {
  const { stdout, stderr } = await runner(executable, requestFile);
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.status, "success");
  assert.equal(result.exit_code, 0);
  assert.deepEqual(JSON.parse(await readFile(statusFile, "utf8")), result);
  assert.equal((await readFile(outputFile)).toString("base64"), fixturePngBase64);
}

const packageRoot = readPackageRoot(process.argv.slice(2));
const executable = path.join(packageRoot, "bin", binaryName());
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
  if (request.url === "/v1/images/generations") {
    const payload = JSON.parse(body);
    assert.ok([
      '中文生成 prompt with spaces and "quotes"',
      'installed package prompt with spaces and "quotes"',
    ].includes(payload.prompt));
  } else {
    assert.equal(request.url, "/v1/images/edits");
    assert.match(request.headers["content-type"], /^multipart\/form-data/);
    assert.match(body.toString("latin1"), /keep composition and change scarf to blue/);
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ data: [{ b64_json: fixturePngBase64 }] }));
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
  await assertSuccessfulRequest(executable, generateRequest, generateStatus, generatedImage);

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
  await assertSuccessfulRequest(executable, editRequest, editStatus, editedImage);

  if (process.platform === "win32") {
    await assertSuccessfulRequest(executable, generateRequest, generateStatus, generatedImage, runNativeViaPowerShell);
    await assertSuccessfulRequest(executable, editRequest, editStatus, editedImage, runNativeViaPowerShell);
  }

  const installResult = JSON.parse((await runNativeInstall(executable, installedSkill, installedConfigPath)).stdout);
  assert.equal(installResult.status, "success");
  assert.equal(installResult.protocol, "request-file-v1");
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
  await assertSuccessfulRequest(path.join(installedSkill, "bin", binaryName()), installedRequest, installedStatus, installedOutput);
});

assert.equal(requestCount, process.platform === "win32" ? 5 : 3);
process.stdout.write(`${JSON.stringify({ status: "success", platform: `${process.platform}-${process.arch}`, package_root: packageRoot, generate: generatedImage, edit: editedImage })}\n`);
