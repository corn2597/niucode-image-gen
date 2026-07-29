import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import TOML from "@iarna/toml";

import { defaultOutputDirectory, legacyPicturesOutputDirectory, resolveSkillRoot } from "./image-client.mjs";

const SKILL_NAME = "niucodes-image-gen";
const LEGACY_SERVER_NAME = "niucodes_image_gen";

export function selectPlatformBinary({ platform = process.platform, arch = process.arch, skillRoot } = {}) {
  if (platform === "darwin" && arch === "arm64") return path.join(skillRoot, "bin", "niucodes-image-gen-macos-arm64");
  if (platform === "darwin" && arch === "x64") return path.join(skillRoot, "bin", "niucodes-image-gen-macos-x64");
  if (platform === "win32" && arch === "x64") return path.join(skillRoot, "bin", "niucodes-image-gen-win-x64.exe");
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

export function defaultInstallDir(home = os.homedir()) {
  return path.join(home, ".codex", "skills", SKILL_NAME);
}

export function defaultConfigPath(home = os.homedir()) {
  return path.join(home, ".codex", "config.toml");
}

export function mergeSandboxWritableRoot(configText, writableRoot) {
  const parsed = TOML.parse(configText || "");
  const sandbox = parsed.sandbox_workspace_write ?? {};
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) {
    throw new Error("[sandbox_workspace_write] must be a TOML table.");
  }
  const currentRoots = sandbox.writable_roots ?? [];
  if (!Array.isArray(currentRoots) || !currentRoots.every((value) => typeof value === "string")) {
    throw new Error("sandbox_workspace_write.writable_roots must be an array of strings.");
  }
  const normalizedRoot = path.resolve(writableRoot);
  if (currentRoots.some((value) => path.resolve(value) === normalizedRoot)) return configText;
  sandbox.writable_roots = [...currentRoots, normalizedRoot];
  parsed.sandbox_workspace_write = sandbox;
  return TOML.stringify(parsed);
}

export function removeLegacyMcpServerConfig(configText) {
  const headerPattern = new RegExp(`^\\[mcp_servers\\.${LEGACY_SERVER_NAME}\\][^\\n]*(?:\\n|$)`, "m");
  const match = configText.match(headerPattern);
  if (!match || match.index === undefined) return configText;
  const blockStart = match.index;
  const afterHeaderStart = blockStart + match[0].length;
  const nextHeaderMatch = configText.slice(afterHeaderStart).match(/^\[[^\n]+\][^\n]*(?:\n|$)/m);
  const blockEnd = nextHeaderMatch?.index === undefined
    ? configText.length
    : afterHeaderStart + nextHeaderMatch.index;
  const retained = `${configText.slice(0, blockStart)}${configText.slice(blockEnd)}`
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return retained ? `${retained}\n` : "";
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfPresent(source, target) {
  if (await exists(source)) {
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }
}

async function copyRuntimePackage(packageRoot, installDir, existingConfigPath) {
  const staticFiles = [
    "SKILL.md",
    path.join("agents", "openai.yaml"),
    path.join(".codex-plugin", "plugin.json"),
  ];
  for (const relativePath of staticFiles) {
    await copyIfPresent(path.join(packageRoot, relativePath), path.join(installDir, relativePath));
  }
  // Bin contents are fully managed by this package. Replacing the directory
  // prevents obsolete executables from surviving an upgrade.
  await rm(path.join(installDir, "bin"), { recursive: true, force: true });
  await copyIfPresent(path.join(packageRoot, "bin"), path.join(installDir, "bin"));
  const sourceConfig = path.join(packageRoot, "config.json");
  const targetConfig = path.join(installDir, "config.json");
  await copyIfPresent(sourceConfig, targetConfig);
  // Preserve the existing local credential/configuration, never the release
  // template. The release package itself contains no usable API key.
  if (existingConfigPath) await copyIfPresent(existingConfigPath, targetConfig);
}

async function replaceRuntimePackage(packageRoot, installDir) {
  const existingConfigPath = path.join(installDir, "config.json");
  const parentDir = path.dirname(installDir);
  const baseName = path.basename(installDir);
  const stagingDir = path.join(parentDir, `.${baseName}.staging-${process.pid}-${randomUUID()}`);
  const backupDir = path.join(parentDir, `.${baseName}.backup-${process.pid}-${randomUUID()}`);
  let previousMoved = false;

  await mkdir(parentDir, { recursive: true });
  try {
    await copyRuntimePackage(packageRoot, stagingDir, existingConfigPath);
    if (await exists(installDir)) {
      await rename(installDir, backupDir);
      previousMoved = true;
    }
    await rename(stagingDir, installDir);
    if (previousMoved) await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    if (previousMoved && !(await exists(installDir)) && await exists(backupDir)) {
      await rename(backupDir, installDir).catch(() => undefined);
    }
    throw error;
  }
}

export async function setInstalledApiKey(installDir, apiKey) {
  if (!apiKey) throw new Error("An API key is required.");
  const configPath = path.join(installDir, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.apiKey = apiKey;
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, configPath);
}

async function ensureOutputConfig(installDir, { home, platform }) {
  const configPath = path.join(installDir, "config.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error(`Unable to read installed config file: ${configPath}`);
  }
  const configuredOutputDir = typeof config.defaultOutputDir === "string" && config.defaultOutputDir.trim()
    ? path.resolve(config.defaultOutputDir)
    : undefined;
  const outputDir = configuredOutputDir
    ?? path.resolve(legacyPicturesOutputDirectory({ home, platform }));
  config.defaultOutputDir = outputDir;
  // v1.4.x used 570 seconds internally to reserve a local save window. The
  // native v2 runner saves after the completed event, so migrate only that old
  // default to the documented full ten-minute request deadline. Respect any
  // user-selected value.
  if (config.timeoutMs === undefined || Number(config.timeoutMs) === 570000) {
    config.timeoutMs = 600000;
  }
  await mkdir(outputDir, { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, configPath);
  return outputDir;
}

async function updateCodexSandboxConfig(configPath, writableRoot) {
  let currentConfig = "";
  let existed = false;
  if (await exists(configPath)) {
    currentConfig = await readFile(configPath, "utf8");
    existed = true;
  }
  const withoutLegacy = removeLegacyMcpServerConfig(currentConfig);
  const updated = mergeSandboxWritableRoot(withoutLegacy, writableRoot);
  if (updated === currentConfig) return { changed: false, backupPath: null, removedLegacyMcpConfig: false };

  await mkdir(path.dirname(configPath), { recursive: true });
  let backupPath = null;
  if (existed) {
    backupPath = `${configPath}.niucodes-image-gen.${Date.now()}.bak`;
    await writeFile(backupPath, currentConfig, { mode: 0o600 });
  }
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, updated, { mode: 0o600 });
  await rename(temporaryPath, configPath);
  return {
    changed: true,
    backupPath,
    removedLegacyMcpConfig: withoutLegacy !== currentConfig,
  };
}

function promptForApiKey() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("API key input requires an interactive terminal.");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const input = process.stdin;
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    const finish = () => {
      cleanup();
      process.stdout.write("\n");
      if (!value) reject(new Error("An API key is required."));
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) {
          cleanup();
          reject(new Error("API key input cancelled."));
          return;
        }
        if (byte === 13 || byte === 10) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32) value += String.fromCharCode(byte);
      }
    };

    process.stdout.write("请输入 niucodes的api key，api key查找地址： workspace.claudecodes.org， 点击左侧API密钥复制：");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function removeLegacyRunners(installDir) {
  // Installed skills are native-only. Remove the entire legacy directory so a
  // previous PowerShell or shell runner cannot survive an in-place upgrade.
  await rm(path.join(installDir, "scripts"), { recursive: true, force: true });
}

export async function installSkill({
  packageRoot = resolveSkillRoot(),
  installDir = defaultInstallDir(),
  configPath = defaultConfigPath(),
  platform = process.platform,
  arch = process.arch,
  home = os.homedir(),
} = {}) {
  const sourceRoot = path.resolve(packageRoot);
  const targetRoot = path.resolve(installDir);
  if (sourceRoot !== targetRoot) {
    await replaceRuntimePackage(sourceRoot, targetRoot);
  }
  await removeLegacyRunners(targetRoot);
  const executable = selectPlatformBinary({ platform, arch, skillRoot: targetRoot });
  if (!(await exists(executable))) {
    throw new Error(`Installed executable was not found: ${executable}`);
  }
  const defaultOutputDir = await ensureOutputConfig(targetRoot, { home, platform });
  const sandboxConfig = await updateCodexSandboxConfig(path.resolve(configPath), defaultOutputDir);
  const fallbackSandboxConfig = await updateCodexSandboxConfig(
    path.resolve(configPath),
    defaultOutputDirectory({ home, platform }),
  );
  return {
    status: "success",
    skill_dir: targetRoot,
    config_path: path.resolve(configPath),
    executable,
    protocol: "stream-stdin-v2-single-frame",
    removed_legacy_mcp_config: sandboxConfig.removedLegacyMcpConfig,
    sandbox_config_updated: sandboxConfig.changed || fallbackSandboxConfig.changed,
    config_backup_path: sandboxConfig.backupPath,
    default_output_dir: defaultOutputDir,
    restart_required: true,
  };
}

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path.`);
  return value;
}

export async function runInstaller(argv) {
  const installDir = readFlag(argv, "--install-dir");
  const configPath = readFlag(argv, "--config-path");
  const promptApiKey = argv.includes("--prompt-api-key");
  const unsupported = argv.filter((value) => value.startsWith("--") && !["--install-dir", "--config-path", "--prompt-api-key"].includes(value));
  if (unsupported.length > 0) throw new Error(`Unsupported install option: ${unsupported[0]}`);
  const apiKey = promptApiKey ? await promptForApiKey() : undefined;
  const result = await installSkill({ installDir, configPath });
  if (apiKey !== undefined) await setInstalledApiKey(result.skill_dir, apiKey);
  return { ...result, api_key_configured: apiKey !== undefined };
}
