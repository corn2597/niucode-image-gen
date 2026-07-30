import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { patchWindowsSubsystem } from "../patch-windows-subsystem.mjs";

test("Windows release executable is patched to the GUI subsystem", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "niucodes-pe-subsystem-"));
  const executable = path.join(root, "fixture.exe");
  const fixture = Buffer.alloc(256);
  fixture.write("MZ", 0, "ascii");
  fixture.writeUInt32LE(0x80, 0x3c);
  fixture.writeUInt32LE(0x00004550, 0x80);
  fixture.writeUInt16LE(0x020b, 0x80 + 24);
  fixture.writeUInt16LE(3, 0x80 + 24 + 68);
  await writeFile(executable, fixture);

  await patchWindowsSubsystem(executable);

  const patched = await readFile(executable);
  assert.equal(patched.readUInt16LE(0x80 + 24 + 68), 2);
});
