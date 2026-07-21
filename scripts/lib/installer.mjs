import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveSkillRoot } from "./image-client.mjs";

const SKILL_NAME = "niucodes-image-gen";
const SERVER_NAME = "niucodes_image_gen";

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

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

export function upsertMcpServerConfig(configText, { command, cwd }) {
  const headerPattern = /^\[mcp_servers\.niucodes_image_gen\][^\n]*(?:\n|$)/m;
  const match = configText.match(headerPattern);
  let retained = configText;
  if (match && match.index !== undefined) {
    const blockStart = match.index;
    const afterHeaderStart = blockStart + match[0].length;
    const nextHeaderMatch = configText.slice(afterHeaderStart).match(/^\[[^\n]+\][^\n]*(?:\n|$)/m);
    const blockEnd = nextHeaderMatch?.index === undefined
      ? configText.length
      : afterHeaderStart + nextHeaderMatch.index;
    retained = `${configText.slice(0, blockStart)}${configText.slice(blockEnd)}`;
  }
  retained = retained.replace(/\n{3,}/g, "\n\n").trimEnd();
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(command)}`,
    'args = ["mcp"]',
    `cwd = ${tomlString(cwd)}`,
  ].join("\n");
  return `${retained}${retained ? "\n\n" : ""}${block}\n`;
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

async function copyRuntimePackage(packageRoot, installDir) {
  const staticFiles = [
    "SKILL.md",
    path.join("agents", "openai.yaml"),
    path.join(".codex-plugin", "plugin.json"),
  ];
  for (const relativePath of staticFiles) {
    await copyIfPresent(path.join(packageRoot, relativePath), path.join(installDir, relativePath));
  }
  await copyIfPresent(path.join(packageRoot, "bin"), path.join(installDir, "bin"));
  const sourceConfig = path.join(packageRoot, "config.json");
  const targetConfig = path.join(installDir, "config.json");
  if (!(await exists(targetConfig))) {
    await copyIfPresent(sourceConfig, targetConfig);
  }
}

export async function installSkill({
  packageRoot = resolveSkillRoot(),
  installDir = defaultInstallDir(),
  configPath = defaultConfigPath(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const sourceRoot = path.resolve(packageRoot);
  const targetRoot = path.resolve(installDir);
  if (sourceRoot !== targetRoot) {
    await copyRuntimePackage(sourceRoot, targetRoot);
  }
  const command = selectPlatformBinary({ platform, arch, skillRoot: targetRoot });
  if (!(await exists(command))) {
    throw new Error(`Installed MCP executable was not found: ${command}`);
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  const currentConfig = (await exists(configPath)) ? await readFile(configPath, "utf8") : "";
  await writeFile(configPath, upsertMcpServerConfig(currentConfig, { command, cwd: targetRoot }), { mode: 0o600 });
  return {
    status: "success",
    skill_dir: targetRoot,
    config_path: path.resolve(configPath),
    mcp_server: SERVER_NAME,
    command,
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
  const unsupported = argv.filter((value) => value.startsWith("--") && !["--install-dir", "--config-path"].includes(value));
  if (unsupported.length > 0) throw new Error(`Unsupported install option: ${unsupported[0]}`);
  return installSkill({ installDir, configPath });
}
