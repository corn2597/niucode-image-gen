import { File as BufferFile } from "node:buffer";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import OpenAI, { toFile } from "openai";

// Node 18 exposes File via node:buffer but not consistently as a global.
if (typeof globalThis.File === "undefined") {
  Object.defineProperty(globalThis, "File", {
    configurable: true,
    value: BufferFile,
    writable: true,
  });
}

export const DEFAULT_BASE_URL = "https://api-direct.claudecodes.org/v1";
export const DEFAULT_GENERATE_SIZE = "1024x1024";
export const DEFAULT_EDIT_SIZE = "auto";

function normalizeObjectKeys(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key
        .replace(/[_-]([a-z])/gi, (_, char) => char.toUpperCase())
        .replace(/^baseUrl$/, "baseURL"),
      value,
    ]),
  );
}

function mergeDefinedObjects(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(normalizeObjectKeys(source))) {
      if (value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "")) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseInteger(value, fieldName, { min, max, fallback } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) throw new Error(`${fieldName} must be an integer`);
  if (min !== undefined && parsed < min) throw new Error(`${fieldName} must be >= ${min}`);
  if (max !== undefined && parsed > max) throw new Error(`${fieldName} must be <= ${max}`);
  return parsed;
}

function parseString(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim();
}

function parsePrompt(value) {
  if (value === undefined || value === null) return undefined;
  const prompt = String(value);
  return prompt.trim() === "" ? undefined : prompt;
}

function parseStringArray(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [String(value)];
}

function validateChoice(value, fieldName, allowedValues) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim();
  if (!allowedValues.includes(normalized)) {
    throw new Error(`${fieldName} must be one of: ${allowedValues.join(", ")}`);
  }
  return normalized;
}

export function resolveSkillRoot() {
  if (process.pkg) {
    return path.resolve(path.dirname(process.execPath), "..");
  }
  if (process.env.NIUCODES_IMAGE_GEN_SKILL_DIR) {
    return path.resolve(process.env.NIUCODES_IMAGE_GEN_SKILL_DIR);
  }
  const entryPath = process.argv[1];
  if (entryPath && path.basename(entryPath) === "niucodes-image-gen.mjs") {
    return path.resolve(path.dirname(entryPath), "..");
  }
  return process.cwd();
}

export function resolveConfigPath(configPath, cwd = process.cwd()) {
  return configPath
    ? path.resolve(cwd, String(configPath))
    : path.join(resolveSkillRoot(), "config.json");
}

function isPathWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readConfigFile(configPath, cwd) {
  const resolvedPath = resolveConfigPath(configPath, cwd);
  try {
    return normalizeObjectKeys(JSON.parse(await readFile(resolvedPath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${resolvedPath}`);
    }
    throw new Error(`Unable to read config file: ${resolvedPath}`);
  }
}

async function assertLocalFile(filePath) {
  const resolved = path.resolve(filePath);
  const stream = createReadStream(resolved);
  try {
    await new Promise((resolve, reject) => {
      stream.once("open", resolve);
      stream.once("error", reject);
    });
    return resolved;
  } finally {
    stream.destroy();
  }
}

function detectMimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

async function toUploadable(filePath) {
  const resolved = await assertLocalFile(filePath);
  return toFile(createReadStream(resolved), path.basename(resolved), { type: detectMimeType(resolved) });
}

function trimTrailingSlash(value) {
  return value ? value.replace(/\/+$/, "") : value;
}

function applySharedPayload(invocation) {
  const payload = {
    model: invocation.model,
    prompt: invocation.prompt,
    n: invocation.n,
    quality: invocation.quality,
    size: invocation.size,
    output_format: invocation.outputFormat,
    moderation: invocation.moderation,
  };
  if (invocation.background !== undefined) payload.background = invocation.background;
  if (invocation.outputCompression !== undefined) payload.output_compression = invocation.outputCompression;
  if (invocation.user !== undefined) payload.user = invocation.user;
  return payload;
}

export async function resolveInvocation(command, cliOptions, { cwd = process.cwd() } = {}) {
  const config = await readConfigFile(cliOptions.config, cwd);
  const merged = mergeDefinedObjects(config, cliOptions);
  const defaultSize = command === "generate" ? DEFAULT_GENERATE_SIZE : DEFAULT_EDIT_SIZE;
  const images = parseStringArray(cliOptions.image.length > 0 ? cliOptions.image : merged.image);
  const invocation = {
    command,
    cwd,
    apiKey: parseString(config.apiKey, undefined),
    baseURL: trimTrailingSlash(parseString(merged.baseURL, DEFAULT_BASE_URL)),
    model: parseString(merged.model, "gpt-image-2"),
    prompt: parsePrompt(merged.prompt),
    output: parseString(merged.output, undefined),
    outputFormat: validateChoice(parseString(merged.outputFormat, "png"), "outputFormat", ["png", "jpeg", "webp"]),
    quality: validateChoice(parseString(merged.quality, "auto"), "quality", ["auto", "low", "medium", "high"]),
    size: parseString(merged.size, defaultSize),
    background: validateChoice(parseString(merged.background, "auto"), "background", ["auto", "opaque", "transparent"]),
    moderation: validateChoice(parseString(merged.moderation, "auto"), "moderation", ["auto", "low"]),
    inputFidelity: validateChoice(parseString(merged.inputFidelity, undefined), "inputFidelity", ["low", "high"]),
    outputCompression: parseInteger(merged.outputCompression, "outputCompression", { min: 0, max: 100 }),
    n: parseInteger(merged.n, "n", { min: 1, max: 10, fallback: 1 }),
    timeoutMs: parseInteger(merged.timeoutMs, "timeoutMs", { min: 1000, max: 600000, fallback: 180000 }),
    overwrite: parseBoolean(merged.overwrite, false),
    mask: parseString(merged.mask, undefined),
    user: parseString(merged.user, undefined),
    images,
  };

  if (!invocation.prompt) throw new Error("Missing prompt. Pass --prompt.");
  if (!invocation.output) {
    throw new Error("Missing output directory. Pass --output <directory> outside the skill directory.");
  }

  const outputPath = path.resolve(cwd, invocation.output);
  if (isPathWithin(resolveSkillRoot(), outputPath)) {
    throw new Error("Output must be outside the skill directory. Pass --output <directory> in a user-owned location.");
  }

  if (invocation.outputCompression !== undefined && invocation.outputFormat === "png") {
    throw new Error("outputCompression is only supported with jpeg or webp output.");
  }
  if (command === "generate" && invocation.images.length > 0) throw new Error("generate does not accept --image.");
  if (command === "generate" && invocation.mask) throw new Error("generate does not accept --mask.");
  if (command === "generate" && invocation.inputFidelity) throw new Error("generate does not accept --input-fidelity.");
  if (command === "edit" && invocation.images.length === 0) throw new Error("edit requires at least one --image <local-path>.");
  return invocation;
}

export async function createImageRequest(invocation) {
  const client = new OpenAI({
    apiKey: invocation.apiKey,
    baseURL: invocation.baseURL,
    // This wrapper favors returning a failure promptly over hidden retry delays.
    maxRetries: 0,
    timeout: invocation.timeoutMs,
  });
  const payload = applySharedPayload(invocation);
  if (invocation.command === "generate") {
    const apiStartedAt = performance.now();
    return {
      response: await client.images.generate(payload),
      inputPrepareMs: 0,
      apiDurationMs: Math.round(performance.now() - apiStartedAt),
    };
  }

  const preparationStartedAt = performance.now();
  const images = await Promise.all(invocation.images.map((filePath) => toUploadable(path.resolve(invocation.cwd, filePath))));
  const editPayload = { ...payload, image: images.length === 1 ? images[0] : images };
  if (invocation.mask) editPayload.mask = await toUploadable(path.resolve(invocation.cwd, invocation.mask));
  if (invocation.inputFidelity) editPayload.input_fidelity = invocation.inputFidelity;
  const inputPrepareMs = Math.round(performance.now() - preparationStartedAt);
  const apiStartedAt = performance.now();
  return {
    response: await client.images.edit(editPayload),
    inputPrepareMs,
    apiDurationMs: Math.round(performance.now() - apiStartedAt),
  };
}

export function formatOpenAIError(error) {
  if (!error || typeof error !== "object") return String(error);
  return [error.message, error.code && `code=${error.code}`, error.status && `status=${error.status}`, error.request_id && `request_id=${error.request_id}`]
    .filter(Boolean)
    .join(" | ") || JSON.stringify(error);
}
