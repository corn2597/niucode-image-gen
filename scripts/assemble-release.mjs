import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = metadata.version;
const inputFlag = process.argv.slice(2);
if (inputFlag.length !== 2 || inputFlag[0] !== "--input-dir") {
  throw new Error("Usage: node scripts/assemble-release.mjs --input-dir <directory-with-platform-zips>");
}

const inputDir = path.resolve(inputFlag[1]);
const releaseDir = path.join(root, "release");
const stagingDir = path.join(root, ".release-staging");
const packageName = "niucodes-image-gen";
const platforms = ["macos-arm64", "macos-x64", "win-x64"];
const archiveNames = platforms.map((platform) => `${packageName}-${platform}-v${version}.zip`);

async function zipDirectory(directoryName, archiveName) {
  await execFileAsync("zip", ["-q", "-r", archiveName, directoryName], { cwd: releaseDir });
}

async function checksum(fileName) {
  const bytes = await readFile(path.join(releaseDir, fileName));
  return createHash("sha256").update(bytes).digest("hex");
}

await rm(releaseDir, { recursive: true, force: true });
await rm(stagingDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
await mkdir(stagingDir, { recursive: true });

for (const archiveName of archiveNames) {
  const source = path.join(inputDir, archiveName);
  await cp(source, path.join(releaseDir, archiveName));
  await execFileAsync("unzip", ["-q", source, "-d", stagingDir]);
}

const universalRoot = path.join(releaseDir, packageName);
await cp(path.join(stagingDir, `${packageName}-macos-arm64`), universalRoot, { recursive: true });
for (const platform of platforms.slice(1)) {
  const unpackedRoot = path.join(stagingDir, `${packageName}-${platform}`);
  await cp(path.join(unpackedRoot, "bin"), path.join(universalRoot, "bin"), { recursive: true, force: true });
  await cp(path.join(unpackedRoot, "scripts"), path.join(universalRoot, "scripts"), { recursive: true, force: true });
}

const universalArchive = `${packageName}-v${version}.zip`;
await zipDirectory(packageName, universalArchive);
const allArchives = [universalArchive, ...archiveNames];
const checksums = await Promise.all(allArchives.map(async (name) => `${await checksum(name)}  ${name}`));
await writeFile(path.join(releaseDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
await rm(stagingDir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ status: "success", version, release_dir: releaseDir, archives: allArchives })}\n`);
