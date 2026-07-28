import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("macOS Gitee bootstrap installer downloads, verifies, installs, and writes the local key", async () => {
  const installer = await readFile(path.join(repoRoot, "install-macos.command"), "utf8");
  assert.match(installer, /api\/v5\/repos\/\$\{REPOSITORY\}\/releases\/latest/);
  assert.match(installer, /read -r -s -p/);
  assert.match(installer, /SHA-256 verification failed/);
  assert.match(installer, /install --install-dir/);
  assert.match(installer, /plutil -replace apiKey/);
  assert.match(installer, /chmod 600/);
  assert.doesNotMatch(installer, /images\/(generations|edits)/);
});

test("Windows Gitee bootstrap installer keeps the key local and verifies the package", async () => {
  const installer = await readFile(path.join(repoRoot, "install-windows.ps1"), "utf8");
  assert.match(installer, /api\/v5\/repos\/\$repository\/releases\/latest/);
  assert.match(installer, /Read-Host 'OpenAI Images API key' -AsSecureString/);
  assert.match(installer, /Get-FileHash -Algorithm SHA256/);
  assert.match(installer, /Expand-Archive/);
  assert.match(installer, /install --install-dir/);
  assert.match(installer, /ConvertTo-Json -Depth 20/);
  assert.match(installer, /Remove-Variable -Name apiKey/);
  assert.doesNotMatch(installer, /images\/(generations|edits)/);
});
