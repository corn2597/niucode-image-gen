#!/usr/bin/env node

import process from "node:process";

import { runInstaller } from "./lib/installer.mjs";
import { runCli } from "./lib/cli.mjs";
import { runMcpServer } from "./lib/mcp-server.mjs";

async function main() {
  try {
    if (process.argv[2] === "mcp") {
      await runMcpServer();
      return;
    }
    if (process.argv[2] === "install") {
      process.stdout.write(`${JSON.stringify(await runInstaller(process.argv.slice(3)))}\n`);
      return;
    }
    const exitCode = await runCli(process.argv.slice(2));
    // Allow stdout to drain before Node exits, including when it is captured by a host tool.
    process.exitCode = exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await new Promise((resolve, reject) => {
      process.stderr.write(`${message}\n`, (writeError) => {
        if (writeError) reject(writeError);
        else resolve();
      });
    });
    process.exitCode = 1;
  }
}

main();
