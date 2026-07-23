import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import archiver from "archiver";
import path from "node:path";

const root = path.resolve(".");
const releaseDir = path.join(root, "release");
const packageName = "niucodes-image-gen";
const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = packageMetadata.version;
const argv = process.argv.slice(2);
const platformFlagIndex = argv.indexOf("--platform");
if (platformFlagIndex !== -1 && (argv.length !== 2 || platformFlagIndex !== 0)) {
  throw new Error("Usage: node scripts/create-release.mjs [--platform <platform-id>]");
}
const requestedPlatform = platformFlagIndex === -1 ? undefined : argv[1];

const sharedFiles = [
  "SKILL.md",
  "config.json",
  path.join("agents", "openai.yaml"),
  path.join(".codex-plugin", "plugin.json"),
  "INSTALL.txt",
];

const platforms = [
  {
    id: "macos-arm64",
    binary: "niucodes-image-gen-macos-arm64",
    installer: "install-macos-arm64.command",
  },
  {
    id: "macos-x64",
    binary: "niucodes-image-gen-macos-x64",
    installer: "install-macos-x64.command",
  },
  {
    id: "win-x64",
    binary: "niucodes-image-gen-win-x64.exe",
    installer: "install-windows.cmd",
  },
];

const selectedPlatforms = requestedPlatform === undefined
  ? platforms
  : platforms.filter((platform) => platform.id === requestedPlatform);
if (selectedPlatforms.length === 0) {
  throw new Error(`Unsupported release platform: ${requestedPlatform}`);
}

async function copyFile(relativePath, destinationRoot) {
  const source = path.join(root, relativePath);
  const destination = path.join(destinationRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function makePackage(destinationRoot, selectedPlatforms) {
  for (const relativePath of sharedFiles) {
    await copyFile(relativePath, destinationRoot);
  }
  for (const platform of selectedPlatforms) {
    await copyFile(path.join("bin", platform.binary), destinationRoot);
    await copyFile(path.join("scripts", platform.installer), destinationRoot);
    if (platform.id.startsWith("macos")) {
      await chmod(path.join(destinationRoot, "bin", platform.binary), 0o755);
      await chmod(path.join(destinationRoot, "scripts", platform.installer), 0o755);
    }
  }
}

async function zipDirectory(directoryName, archiveName) {
  await new Promise((resolve, reject) => {
    const output = createWriteStream(path.join(releaseDir, archiveName));
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
    archive.pipe(output);
    archive.directory(path.join(releaseDir, directoryName), directoryName);
    archive.finalize();
  });
}

async function sha256(fileName) {
  const bytes = await readFile(path.join(releaseDir, fileName));
  return createHash("sha256").update(bytes).digest("hex");
}

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });

const archives = [];
if (requestedPlatform === undefined) {
  const fullDirectory = path.join(releaseDir, packageName);
  await makePackage(fullDirectory, platforms);
  const fullArchive = `${packageName}-v${version}.zip`;
  await zipDirectory(packageName, fullArchive);
  archives.push(fullArchive);
}

for (const platform of selectedPlatforms) {
  const directoryName = `${packageName}-${platform.id}`;
  const destination = path.join(releaseDir, directoryName);
  await makePackage(destination, [platform]);
  const archiveName = `${directoryName}-v${version}.zip`;
  await zipDirectory(directoryName, archiveName);
  archives.push(archiveName);
}

const checksums = await Promise.all(archives.map(async (archive) => `${await sha256(archive)}  ${archive}`));
if (requestedPlatform === undefined) {
  await writeFile(path.join(releaseDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
}
process.stdout.write(`${JSON.stringify({ status: "success", version, platform: requestedPlatform ?? "all", release_dir: releaseDir, archives })}\n`);
