#!/usr/bin/env node

import process from "node:process";

import { runCli } from "./lib/cli.mjs";

try {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
