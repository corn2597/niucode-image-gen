import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

function packageDirectory() {
  if (process.platform === "darwin" && process.arch === "arm64") return "niucodes-image-gen-macos-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "niucodes-image-gen-macos-x64";
  if (process.platform === "win32" && process.arch === "x64") return "niucodes-image-gen-win-x64";
  throw new Error(`Unsupported packaged E2E platform: ${process.platform}-${process.arch}`);
}

const packageRoot = path.join("release", packageDirectory());
const child = spawn(process.execPath, [
  "scripts/tests/packaged-e2e.mjs",
  "--package-root",
  packageRoot,
], { stdio: "inherit" });

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
