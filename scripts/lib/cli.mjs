import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_BASE_URL,
  DEFAULT_EDIT_SIZE,
  DEFAULT_GENERATE_SIZE,
  createImageRequest,
  describeOpenAIError,
  formatOpenAIError,
  isRequestDeliveryUnknown,
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
  niucodes-image-gen run --request-file "<absolute-request.json>"
  niucodes-image-gen generate --prompt "..." [options]
  niucodes-image-gen edit --image "<path>" --prompt "..." [options]

Commands:
  run         Execute one structured request file. This is the supported skill entrypoint.
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
  --timeout-ms <ms>             SDK timeout in milliseconds. Default: 600000
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

const REQUEST_FIELDS = new Set([
  "version",
  "command",
  "statusFile",
  "prompt",
  "output",
  "image",
  "mask",
  "quality",
  "size",
  "model",
  "outputFormat",
  "background",
  "moderation",
  "n",
  "overwrite",
  "timeoutMs",
  "verboseResponse",
  "inputFidelity",
  "outputCompression",
  "user",
]);

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
    client_request_id: invocation.clientRequestId,
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

async function readStatusFile(statusFile) {
  if (!statusFile) return undefined;
  try {
    const parsed = JSON.parse(await readFile(statusFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseRequestFile(contents, requestPath) {
  // Windows PowerShell 5.1 commonly writes UTF-8 JSON with a BOM.
  const json = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`Invalid JSON request file: ${requestPath}`);
  }
}

function lifecyclePayload({ command, status, startedAt, timing, saved = [], error = null, requestId = null, clientRequestId = null, exitCode = null, stage }) {
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
    client_request_id: clientRequestId,
    ...(stage ? { stage } : {}),
    ...(error ? { error } : {}),
  };
}

function toRequestObject(rawRequest, requestPath) {
  if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) {
    throw new Error(`Request file must contain a JSON object: ${requestPath}`);
  }

  const request = Object.fromEntries(Object.entries(rawRequest).map(([key, value]) => [
    key.replace(/[_-]([a-z])/gi, (_, char) => char.toUpperCase()),
    value,
  ]));
  if (request.apiKey !== undefined || request.config !== undefined) {
    throw new Error("Request files cannot contain apiKey or config. Use the package-root config.json.");
  }
  const unsupported = Object.keys(request).find((key) => !REQUEST_FIELDS.has(key));
  if (unsupported) throw new Error(`Unsupported request field: ${unsupported}`);
  if (request.version !== 1) throw new Error("Request file version must be 1.");
  if (!["generate", "edit"].includes(request.command)) {
    throw new Error("Request command must be generate or edit.");
  }
  if (typeof request.statusFile !== "string" || !path.isAbsolute(request.statusFile)) {
    throw new Error("Request statusFile must be an absolute path.");
  }
  if (typeof request.output !== "string" || !path.isAbsolute(request.output)) {
    throw new Error("Request output must be an absolute path.");
  }
  if (request.mask !== undefined && (typeof request.mask !== "string" || !path.isAbsolute(request.mask))) {
    throw new Error("Request mask must be an absolute path.");
  }
  if (request.image !== undefined) {
    const images = Array.isArray(request.image) ? request.image : [request.image];
    if (!images.every((image) => typeof image === "string" && path.isAbsolute(image))) {
      throw new Error("Request image must contain only absolute paths.");
    }
  }

  const { command, statusFile, version, ...options } = request;
  return {
    command,
    options: {
      image: [],
      ...options,
      statusFile: path.resolve(statusFile),
    },
  };
}

function requestFailurePayload(command, message, startedAt, startedAtPerformance) {
  return lifecyclePayload({
    command,
    status: "failed",
    startedAt,
    timing: { total: Math.round(performance.now() - startedAtPerformance) },
    exitCode: 1,
    stage: "initialization",
    error: { message },
  });
}

async function runRequestFile(argv, { cwd = process.cwd() } = {}) {
  const startedAt = new Date().toISOString();
  const startedAtPerformance = performance.now();
  let statusFile;
  let command = "run";

  try {
    if (argv.length !== 2 || argv[0] !== "--request-file" || !argv[1]) {
      throw new Error("Usage: niucodes-image-gen run --request-file <absolute-request.json>");
    }
    if (!path.isAbsolute(argv[1])) {
      throw new Error("Request file must be an absolute path.");
    }
    const requestPath = path.resolve(argv[1]);
    const rawRequest = parseRequestFile(await readFile(requestPath, "utf8"), requestPath);
    if (rawRequest && typeof rawRequest === "object" && !Array.isArray(rawRequest)
      && typeof rawRequest.statusFile === "string" && path.isAbsolute(rawRequest.statusFile)) {
      statusFile = path.resolve(rawRequest.statusFile);
    }
    const request = toRequestObject(rawRequest, requestPath);
    command = request.command;
    statusFile = request.options.statusFile;
    const payload = await executeImageCommand(command, request.options, { cwd });
    const finalPayload = await readStatusFile(statusFile) ?? payload;
    await writeStdout(`${stableStringify(finalPayload)}\n`);
    return 0;
  } catch (error) {
    const message = formatOpenAIError(error);
    let payload = await readStatusFile(statusFile);
    if (!payload || !["success", "failed"].includes(payload.status)) {
      payload = requestFailurePayload(command, message, startedAt, startedAtPerformance);
      try {
        await writeStatusFile(statusFile, payload);
      } catch (statusError) {
        await writeStderr(`Unable to write status file: ${formatOpenAIError(statusError)}\n`);
      }
    }
    await writeStderr(`${message}\n`);
    await writeStdout(`${stableStringify(payload)}\n`);
    return Number.isInteger(payload.exit_code) && payload.exit_code !== 0 ? payload.exit_code : 1;
  }
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
  const clientRequestId = randomUUID();

  try {
    const verboseResponse = resolveVerboseResponse(options.verboseResponse);
    const resolveStartedAt = performance.now();
    invocation = await resolveInvocation(command, options, { cwd });
    invocation.clientRequestId = clientRequestId;
    const resolveDurationMs = Math.round(performance.now() - resolveStartedAt);
    await writeStatusFile(statusFile, lifecyclePayload({
      command: invocation.command,
      status: "running",
      startedAt,
      timing: { total: Math.round(performance.now() - cliStartedAt) },
      exitCode: null,
      stage: "request",
      clientRequestId,
    }));
    const { response: apiResponse, inputPrepareMs, apiDurationMs } = await createImageRequest(invocation, { clientRequestId });
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
        stage: invocation && isRequestDeliveryUnknown(error) ? "request_delivery_unknown" : invocation ? "request_or_save" : "initialization",
        error: describeOpenAIError(error),
        clientRequestId: invocation ? clientRequestId : null,
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
  if (argv[0] === "run") {
    return runRequestFile(argv.slice(1), { cwd });
  }
  const parsed = parseArgs(argv);
  if (parsed.help) {
    await writeStdout(`${HELP_TEXT}\n`);
    return 0;
  }

  const payload = await executeImageCommand(parsed.command, parsed.options, { cwd });
  await writeStdout(`${stableStringify(payload)}\n`);
  return 0;
}

export { HELP_TEXT, parseArgs, runRequestFile, toRequestObject };
