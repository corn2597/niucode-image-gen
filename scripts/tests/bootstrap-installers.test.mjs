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

test("Windows Gitee bootstrap installer keeps the key local and verifies the package", async () => {
  const installer = await readFile(path.join(repoRoot, "install-windows.ps1"), "utf8");
  assert.match(installer, /api\/v5\/repos\/\$repository\/releases\/latest/);
  assert.ok(installer.includes("FromBase64String('6K+36L6T5YWlIG5pdWNvZGVz55qEYXBpIGtlee+8jGFwaSBrZXnmn6Xmib7lnLDlnYDvvJogd29ya3NwYWNlLmNsYXVkZWNvZGVzLm9yZ++8jCDngrnlh7vlt6bkvqdBUEnlr4bpkqXlpI3liLbvvJo=')"));
  assert.match(installer, /Read-Host \$apiKeyPrompt -AsSecureString/);
  assert.doesNotMatch(installer, /[^\x00-\x7F]/);
  assert.match(installer, /Get-FileHash -Algorithm SHA256/);
  assert.match(installer, /Expand-Archive/);
  assert.doesNotMatch(installer, /\[regex\]::/i);
  assert.match(installer, /install --install-dir/);
  assert.match(installer, /ConvertTo-Json -Depth 20/);
  assert.match(installer, /Remove-Variable -Name apiKey/);
  assert.doesNotMatch(installer, /images\/(generations|edits)/);
});
