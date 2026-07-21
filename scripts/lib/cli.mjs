import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_BASE_URL,
  DEFAULT_EDIT_SIZE,
  DEFAULT_GENERATE_SIZE,
  createImageRequest,
  formatOpenAIError,
  resolveInvocation,
} from "./image-client.mjs";
import {
  buildRenderables,
  resolveOutputTargets,
  saveImageItems,
  stableStringify,
} from "./output.mjs";

const HELP_TEXT = `niucodes-image-gen

Usage:
  niucodes-image-gen generate --prompt "..." [options]
  niucodes-image-gen edit --image "<path>" --prompt "..." [options]

Commands:
  generate    Call /v1/images/generations through the official OpenAI Node SDK.
  edit        Call /v1/images/edits through the official OpenAI Node SDK.

Common options:
  --config <path>               JSON config path. Defaults to <skill-dir>/config.json.
                                apiKey is read only from this config file.
  --base-url <url>              SDK baseURL. Defaults to ${DEFAULT_BASE_URL}.
  --model <model>               Defaults to gpt-image-2.
  --output <file-or-dir>        Required. Output file or directory outside the skill directory.
  --output-format <fmt>         png | jpeg | webp
  --quality <value>             auto | low | medium | high
  --size <value>                Supported size. Defaults to ${DEFAULT_GENERATE_SIZE} for generate
                                and ${DEFAULT_EDIT_SIZE} for edit.
  --background <value>          auto | opaque | transparent
  --moderation <value>          auto | low
  --n <count>                   Number of images to save. Default: 1
  --overwrite                   Overwrite the first output path if it already exists.
  --timeout-ms <ms>             SDK timeout in milliseconds. Default: 180000
  --status-file <path>          Optional JSON lifecycle file. Written atomically after each state change.
  --verbose-response            Include expanded request/response metadata in the JSON output.

Edit-only options:
  --image <path>                Repeat to upload multiple local reference images.
  --mask <path>                 Optional local mask image path.
  --input-fidelity <value>      low | high. Omit for gpt-image-2.

Display rule:
  The script prints compact JSON by default. Reuse saved[*].markdown in the final answer so Codex,
  VS Code surfaces, and similar clients can render the saved local image files.

`;

function parseArgumentValue(rawValue) {
  if (rawValue === undefined) {
    return true;
  }

  return rawValue;
}

function toCamelCase(flagName) {
  return flagName.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function parseArgs(argv) {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    return {
      command: null,
      options: {},
      help: true,
    };
  }

  const options = {
    image: [],
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--help" || token === "-h") {
      return {
        command,
        options,
        help: true,
      };
    }

    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const trimmed = token.slice(2);
    const [rawName, inlineValue] = trimmed.split("=", 2);
    const optionName = toCamelCase(rawName);

    let value;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      const nextToken = rest[index + 1];
      if (nextToken && !nextToken.startsWith("--")) {
        value = nextToken;
        index += 1;
      }
    }

    value = parseArgumentValue(value);

    if (optionName === "image") {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error("--image requires a local file path");
      }
      options.image.push(value);
      continue;
    }

    options[optionName] = value;
  }

  return {
    command,
    options,
    help: false,
  };
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildResponse(invocation, targets, savedItems, apiResponse, verboseResponse, timing) {
  const renderables = buildRenderables(savedItems, invocation.command);
  const payload = {
    status: "success",
    command: invocation.command,
    exit_code: 0,
    saved: renderables,
    timing_ms: timing,
    error: null,
    request_id: apiResponse?._request_id ?? null,
    model: invocation.model,
    base_url: invocation.baseURL ?? DEFAULT_BASE_URL,
    size: invocation.size,
    quality: invocation.quality,
    output_format: invocation.outputFormat,
    revised_prompt: apiResponse?.data?.[0]?.revised_prompt ?? null,
  };

  if (verboseResponse) {
    payload.request = {
      prompt: invocation.prompt,
      image_count: invocation.images.length,
      mask: invocation.mask ?? null,
      background: invocation.background,
      moderation: invocation.moderation,
      output_compression: invocation.outputCompression ?? null,
      input_fidelity: invocation.inputFidelity ?? null,
      n: invocation.n,
      output: invocation.output ?? null,
      overwrite: invocation.overwrite,
    };
    payload.response = {
      raw_item_count: Array.isArray(apiResponse?.data) ? apiResponse.data.length : targets.length,
    };
    payload.render_hint =
      "Paste each saved[*].markdown string into the final answer to render the saved images in Codex or compatible VS Code surfaces.";
  }

  return payload;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value for --verbose-response: ${value}`);
}

function resolveVerboseResponse(rawValue) {
  return parseBooleanFlag(rawValue, false);
}

function writeToStream(stream, value) {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function writeStdout(value) {
  return writeToStream(process.stdout, value);
}

function writeStderr(value) {
  return writeToStream(process.stderr, value);
}

function resolveStatusFile(statusFile, cwd) {
  if (statusFile === undefined || statusFile === null || statusFile === true || statusFile === "") return undefined;
  return path.resolve(cwd, String(statusFile));
}

async function writeStatusFile(statusFile, payload) {
  if (!statusFile) return;
  await mkdir(path.dirname(statusFile), { recursive: true });
  const temporaryPath = `${statusFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${stableStringify(payload)}\n`, { mode: 0o600 });
  await rename(temporaryPath, statusFile);
}

function lifecyclePayload({ command, status, startedAt, timing, saved = [], error = null, requestId = null, exitCode = null, stage }) {
  return {
    version: 1,
    command,
    status,
    exit_code: exitCode,
    started_at: startedAt,
    completed_at: status === "running" ? null : new Date().toISOString(),
    saved,
    timing_ms: timing,
    error,
    request_id: requestId,
    ...(stage ? { stage } : {}),
    ...(error ? { error } : {}),
  };
}

export async function executeImageCommand(command, options, { cwd = process.cwd() } = {}) {
  const cliStartedAt = performance.now();
  const startedAt = new Date().toISOString();
  if (!["generate", "edit"].includes(command)) {
    throw new Error(`Unsupported command: ${command}`);
  }
  if (options.apiKey !== undefined) {
    throw new Error("--api-key is not supported. Set apiKey in config.json.");
  }

  const statusFile = resolveStatusFile(options.statusFile, cwd);
  let invocation;

  try {
    const verboseResponse = resolveVerboseResponse(options.verboseResponse);
    const resolveStartedAt = performance.now();
    invocation = await resolveInvocation(command, options, { cwd });
    const resolveDurationMs = Math.round(performance.now() - resolveStartedAt);
    await writeStatusFile(statusFile, lifecyclePayload({
      command: invocation.command,
      status: "running",
      startedAt,
      timing: { total: Math.round(performance.now() - cliStartedAt) },
      exitCode: null,
      stage: "request",
    }));
    const { response: apiResponse, inputPrepareMs, apiDurationMs } = await createImageRequest(invocation);
    const outputStartedAt = performance.now();
    const outputTargets = await resolveOutputTargets({
      command: invocation.command,
      cwd,
      model: invocation.model,
      output: invocation.output,
      outputFormat: invocation.outputFormat,
      overwrite: invocation.overwrite,
      count: Array.isArray(apiResponse?.data) && apiResponse.data.length > 0 ? apiResponse.data.length : invocation.n,
    });
    const outputPrepareMs = Math.round(performance.now() - outputStartedAt);

    const saveStartedAt = performance.now();
    const savedItems = await saveImageItems(apiResponse, outputTargets, invocation.timeoutMs);
    const saveDurationMs = Math.round(performance.now() - saveStartedAt);
    const totalMs = Math.round(performance.now() - cliStartedAt);
    const payload = buildResponse(
      invocation,
      outputTargets,
      savedItems,
      apiResponse,
      verboseResponse,
      {
        resolve: resolveDurationMs,
        input_prepare: inputPrepareMs,
        api: apiDurationMs,
        output_prepare: outputPrepareMs,
        save: saveDurationMs,
        non_api: totalMs - apiDurationMs,
        total: totalMs,
      },
    );

    await writeStatusFile(statusFile, { ...payload, version: 1, started_at: startedAt, completed_at: new Date().toISOString(), stage: "complete" });
    return payload;
  } catch (error) {
    try {
      await writeStatusFile(statusFile, lifecyclePayload({
        command: invocation?.command ?? command,
        status: "failed",
        startedAt,
        timing: { total: Math.round(performance.now() - cliStartedAt) },
        stage: invocation ? "request_or_save" : "initialization",
        error: { message: formatOpenAIError(error) },
        exitCode: 1,
      }));
    } catch (statusError) {
      await writeStderr(`Unable to write status file: ${formatOpenAIError(statusError)}\n`);
    }
    if (invocation?.output) {
      const outputExists = await fileExists(invocation.output);
      if (outputExists) {
        await writeStderr(`Output target already exists: ${invocation.output}\n`);
      }
    }
    throw new Error(formatOpenAIError(error));
  }
}

export async function runCli(argv, { cwd = process.cwd() } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    await writeStdout(`${HELP_TEXT}\n`);
    return 0;
  }

  const payload = await executeImageCommand(parsed.command, parsed.options, { cwd });
  await writeStdout(`${stableStringify(payload)}\n`);
  return 0;
}

export { HELP_TEXT, parseArgs };
