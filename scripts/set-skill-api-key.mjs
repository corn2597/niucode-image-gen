#!/usr/bin/env node

import process from "node:process";

import { writeStoredSkillApiKey } from "./lib/skill-api-key.mjs";

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    parsed[key] = value;
    index += 1;
  }

  return parsed;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = args["api-key"];
  const skillDir = args["skill-dir"];

  const skillMdPath = await writeStoredSkillApiKey(apiKey, {
    skillDir,
  });
  process.stdout.write(`Stored API key in ${skillMdPath}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
