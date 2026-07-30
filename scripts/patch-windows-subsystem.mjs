import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PE_SIGNATURE = 0x00004550;
const OPTIONAL_HEADER_PE32 = 0x010b;
const OPTIONAL_HEADER_PE32_PLUS = 0x020b;
const WINDOWS_GUI_SUBSYSTEM = 2;
const SUBSYSTEM_OFFSET = 68;

export async function patchWindowsSubsystem(executablePath) {
  const resolvedPath = path.resolve(executablePath);
  const handle = await open(resolvedPath, "r+");
  try {
    const dosHeader = Buffer.alloc(64);
    await handle.read(dosHeader, 0, dosHeader.length, 0);
    if (dosHeader.toString("ascii", 0, 2) !== "MZ") {
      throw new Error(`Not a Windows PE executable: ${resolvedPath}`);
    }

    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(26);
    await handle.read(peHeader, 0, peHeader.length, peOffset);
    if (peHeader.readUInt32LE(0) !== PE_SIGNATURE) {
      throw new Error(`Invalid PE signature: ${resolvedPath}`);
    }

    const optionalHeaderOffset = peOffset + 24;
    const optionalMagic = peHeader.readUInt16LE(24);
    if (![OPTIONAL_HEADER_PE32, OPTIONAL_HEADER_PE32_PLUS].includes(optionalMagic)) {
      throw new Error(`Unsupported PE optional header: 0x${optionalMagic.toString(16)}`);
    }

    const subsystem = Buffer.alloc(2);
    subsystem.writeUInt16LE(WINDOWS_GUI_SUBSYSTEM);
    await handle.write(subsystem, 0, subsystem.length, optionalHeaderOffset + SUBSYSTEM_OFFSET);
    await handle.sync();
  } finally {
    await handle.close();
  }

  return resolvedPath;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const executablePath = process.argv[2];
  if (!executablePath) throw new Error("Usage: patch-windows-subsystem.mjs <executable.exe>");
  await patchWindowsSubsystem(executablePath);
}
