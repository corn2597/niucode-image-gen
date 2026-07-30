import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("macOS Gitee bootstrap installer downloads, verifies, installs, and writes the local key", async () => {
  const installer = await readFile(path.join(repoRoot, "install-macos.command"), "utf8");
  assert.match(installer, /api\/v5\/repos\/\$\{REPOSITORY\}\/releases\/latest/);
  assert.match(installer, /read -r -s -p/);
  assert.match(installer, /请输入 niucodes的api key，api key查找地址： workspace\.claudecodes\.org， 点击左侧API密钥复制：/);
  assert.match(installer, /SHA-256 verification failed/);
  assert.match(installer, /install --install-dir/);
  assert.match(installer, /plutil -replace apiKey/);
  assert.match(installer, /chmod 600/);
  assert.doesNotMatch(installer, /images\/(generations|edits)/);
});

test("Windows CMD bootstrap installer verifies and installs the current Gitee package", async () => {
  const installer = await readFile(path.join(repoRoot, "install-windows.cmd"), "utf8");
  assert.match(installer, /release-version\.txt/);
  assert.match(installer, /curl\.exe --fail --location/);
  assert.match(installer, /certutil\.exe -hashfile/);
  assert.match(installer, /for \/f "tokens=1,2"/i);
  assert.match(installer, /if \/I "%%I"=="%ARCHIVE_NAME%" set "EXPECTED_SHA=%%H"/);
  assert.match(installer, /if \/I "%%I"=="\*%ARCHIVE_NAME%" set "EXPECTED_SHA=%%H"/);
  assert.doesNotMatch(installer, /findstr \/R \/C:.*ARCHIVE_NAME/);
  assert.match(installer, /tar\.exe -xf/);
  assert.match(installer, /--prompt-api-key/);
  assert.doesNotMatch(installer, /[^\x00-\x7F]/);
  assert.doesNotMatch(installer, /powershell|\.ps1/i);
  assert.doesNotMatch(installer, /images\/(generations|edits)/);

  const instructions = await readFile(path.join(repoRoot, "INSTALL.txt"), "utf8");
  assert.match(instructions, /Double-click install-windows\.cmd/);
  assert.doesNotMatch(instructions, /Windows PowerShell|install-windows\.ps1/i);
});
