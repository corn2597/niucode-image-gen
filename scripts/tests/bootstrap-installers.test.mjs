import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("package, plugin, and installer release versions stay synchronized", async () => {
  const packageMetadata = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const pluginMetadata = JSON.parse(await readFile(path.join(repoRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const releaseVersion = (await readFile(path.join(repoRoot, "release-version.txt"), "utf8")).trim();
  assert.equal(pluginMetadata.version, packageMetadata.version);
  assert.equal(releaseVersion, `v${packageMetadata.version}`);
});

test("macOS GUI installer uses the fixed latest Gitee release and only asks for an API key", async () => {
  const source = await readFile(path.join(repoRoot, "macos-installer", "InstallerApp.swift"), "utf8");
  assert.match(source, /gitee\.com\/api\/v5\/repos\/niucodes\/niucode-image-gen\/releases\/latest/);
  assert.match(source, /NSSecureTextField/);
  assert.match(source, /config\["apiKey"\] = apiKey/);
  assert.match(source, /SHA256\.hash/);
  assert.match(source, /SHA-256 校验失败/);
  assert.match(source, /"install"/);
  assert.doesNotMatch(source, /images\/(generations|edits)/);
  assert.doesNotMatch(source, /baseURL|model|protocol/);
});

test("release scripts contain exactly two macOS packages and two DMG installers", async () => {
  const createRelease = await readFile(path.join(repoRoot, "scripts", "create-release.mjs"), "utf8");
  const assembleRelease = await readFile(path.join(repoRoot, "scripts", "assemble-release.mjs"), "utf8");
  const workflow = await readFile(path.join(repoRoot, ".github", "workflows", "publish-release.yml"), "utf8");
  for (const platform of ["macos-arm64", "macos-x64"]) {
    assert.match(createRelease, new RegExp(platform));
    assert.match(assembleRelease, new RegExp(`installer-${platform}`));
    assert.match(workflow, new RegExp(platform));
  }
  assert.match(workflow, /installer-\$\{\{ matrix\.id \}\}/);
  for (const contents of [createRelease, assembleRelease, workflow]) {
    assert.doesNotMatch(contents, /win-x64|windows|\.cmd|\.exe/i);
  }
});
