#!/usr/bin/env node

import process from "node:process";

import { runInstaller } from "./lib/installer.mjs";
import { runCli } from "./lib/cli.mjs";

async function main() {
  try {
    if (process.argv[2] === "install") {
      process.stdout.write(`${JSON.stringify(await runInstaller(process.argv.slice(3)))}\n`);
      return;
    }
    const exitCode = await runCli(process.argv.slice(2));
    // runCli waits for the final stdout write callback. Give a terminal pipe a
    // brief chance to consume that JSON before force-ending this one-shot CLI;
    // an upstream proxy or keep-alive socket must not hold it open afterward.
    await new Promise((resolve) => setTimeout(resolve, 25));
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await new Promise((resolve, reject) => {
      process.stderr.write(`${message}\n`, (writeError) => {
        if (writeError) reject(writeError);
        else resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    process.exit(1);
  }
}

main();
