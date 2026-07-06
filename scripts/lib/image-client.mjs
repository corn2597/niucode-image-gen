import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import OpenAI, { toFile } from "openai";
import { readStoredSkillApiKey } from "./skill-api-key.mjs";

export const DEFAULT_BASE_URL = "https://api-direct.claudecodes.org/v1";
export const DEFAULT_GENERATE_SIZE = "1024x1024";
export const DEFAULT_EDIT_SIZE = "auto";
export const SUPPORTED_PROVIDER_DOMAIN_SUFFIXES = ["claudecodes.org", "niucodes.com"];

function normalizeObjectKeys(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(input)) {
    const camelKey = key
      .replace(/[_-]([a-z])/gi, (_, char) => char.toUpperCase())
      .replace(/^baseUrl$/, "baseURL")
      .replace(/^apiKey$/, "apiKey");
    normalized[camelKey] = value;
  }
  return normalized;
}

function mergeDefinedObjects(...sources) {
  const merged = {};
  for (const source of sources) {
    const normalized = normalizeObjectKeys(source);
    for (const [key, value] of Object.entries(normalized)) {
      if (value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "")) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function normalizeUrlForMatch(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return String(value).trim().replace(/\/+$/, "").toLowerCase();
}

function extractHostnameFromUrl(value) {
  const normalized = normalizeUrlForMatch(value);
  if (!normalized) {
    return undefined;
  }

  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function matchesSupportedProviderDomainSuffix(value) {
  const hostname = extractHostnameFromUrl(value);
  if (!hostname) {
    return false;
  }

  return SUPPORTED_PROVIDER_DOMAIN_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function parseBoolean(value, fallback = false) {
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
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseInteger(value, fieldName, { min, max, fallback } = {}) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  if (min !== undefined && parsed < min) {
    throw new Error(`${fieldName} must be >= ${min}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${fieldName} must be <= ${max}`);
  }
  return parsed;
}

function parseString(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value).trim();
}

function parseStringArray(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  return [String(value)];
}

function validateChoice(value, fieldName, allowedValues) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const normalized = String(value).trim();
  if (!allowedValues.includes(normalized)) {
    throw new Error(`${fieldName} must be one of: ${allowedValues.join(", ")}`);
  }
  return normalized;
}

async function readConfigFile(configPath, cwd) {
  if (!configPath) {
    return {};
  }

  const resolvedPath = path.resolve(cwd, String(configPath));
  const raw = await readFile(resolvedPath, "utf8");
  const parsed = JSON.parse(raw);
  return normalizeObjectKeys(parsed);
}

function readEnvironmentConfig(env) {
  return normalizeObjectKeys({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
    model: env.OPENAI_IMAGE_MODEL,
    size: env.OPENAI_IMAGE_SIZE,
    quality: env.OPENAI_IMAGE_QUALITY,
    outputFormat: env.OPENAI_IMAGE_FORMAT,
    background: env.OPENAI_IMAGE_BACKGROUND,
    moderation: env.OPENAI_IMAGE_MODERATION,
    timeoutMs: env.OPENAI_IMAGE_TIMEOUT_MS,
  });
}

function extractTopLevelTomlString(rawToml, keyName) {
  if (!rawToml) {
    return undefined;
  }

  const lines = rawToml.split(/\r?\n/);
  let insideSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      insideSection = true;
      continue;
    }

    if (insideSection) {
      continue;
    }

    const match = line.match(new RegExp(`^\\s*${keyName}\\s*=\\s*"([^"]+)"`));
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  return undefined;
}

function extractTomlSectionString(rawToml, sectionName, keyName) {
  if (!rawToml || !sectionName) {
    return undefined;
  }

  const lines = rawToml.split(/\r?\n/);
  const targetSectionHeader = `[${sectionName}]`;
  let insideTargetSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      insideTargetSection = trimmed === targetSectionHeader;
      continue;
    }

    if (!insideTargetSection) {
      continue;
    }

    const match = line.match(new RegExp(`^\\s*${keyName}\\s*=\\s*"([^"]+)"`));
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  return undefined;
}

function extractSelectedProviderConfig(rawToml) {
  const modelProvider = extractTopLevelTomlString(rawToml, "model_provider");
  if (!modelProvider) {
    return {};
  }

  const sectionName = `model_providers.${modelProvider}`;
  return {
    modelProvider,
    baseURL: extractTomlSectionString(rawToml, sectionName, "base_url"),
    experimentalBearerToken: extractTomlSectionString(rawToml, sectionName, "experimental_bearer_token"),
  };
}

function resolveCodexHome(env) {
  if (env.CODEX_HOME) {
    return env.CODEX_HOME;
  }

  if (env.USERPROFILE) {
    return path.join(env.USERPROFILE, ".codex");
  }

  if (env.HOME) {
    return path.join(env.HOME, ".codex");
  }

  return null;
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function extractAuthJsonApiKey(rawAuth) {
  if (!rawAuth || typeof rawAuth !== "object") {
    return undefined;
  }

  const candidateFields = [
    "OPENAI_API_KEY",
    "openai_api_key",
    "LUPOAPI_API_KEY",
    "LUOAPI_API_KEY",
    "API_KEY",
    "apiKey",
    "api_key",
  ];

  for (const fieldName of candidateFields) {
    const candidate = rawAuth[fieldName];
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }

  return undefined;
}

function extractAuthMode(rawAuth) {
  if (!rawAuth || typeof rawAuth !== "object") {
    return undefined;
  }

  const authMode = rawAuth.auth_mode;
  if (typeof authMode !== "string" || authMode.trim() === "") {
    return undefined;
  }

  return authMode.trim().toLowerCase();
}

function isApiLoginMode(authMode) {
  return authMode === "api";
}

function isAccountLoginMode(authMode) {
  return authMode === "chatgpt" || authMode === "account";
}

async function readDiscoveredCredentials(env) {
  const codexHome = resolveCodexHome(env);
  if (!codexHome) {
    return {};
  }

  const authJsonPath = path.join(codexHome, "auth.json");
  const authJsonText = await readTextIfExists(authJsonPath);
  const configTomlPath = path.join(codexHome, "config.toml");
  const configTomlText = await readTextIfExists(configTomlPath);
  const selectedProviderConfig = extractSelectedProviderConfig(configTomlText);
  const selectedProviderMatches = matchesSupportedProviderDomainSuffix(selectedProviderConfig.baseURL);

  if (authJsonText) {
    const authJson = JSON.parse(authJsonText);
    const authMode = extractAuthMode(authJson);

    if (isApiLoginMode(authMode) && selectedProviderMatches) {
      const authJsonApiKey = extractAuthJsonApiKey(authJson);
      if (authJsonApiKey) {
        return {
          apiKey: authJsonApiKey,
        };
      }
    }

    if (isAccountLoginMode(authMode) && selectedProviderConfig.modelProvider && selectedProviderMatches) {
      if (selectedProviderConfig.experimentalBearerToken) {
        return {
          apiKey: selectedProviderConfig.experimentalBearerToken,
        };
      }
    }
  }

  const storedSkillApiKey = await readStoredSkillApiKey(env);
  if (storedSkillApiKey) {
    return {
      apiKey: storedSkillApiKey,
    };
  }

  return {};
}

async function assertLocalFile(filePath) {
  const resolved = path.resolve(filePath);
  let stream;
  try {
    stream = createReadStream(resolved);
    await new Promise((resolve, reject) => {
      stream.once("open", resolve);
      stream.once("error", reject);
    });
    return resolved;
  } finally {
    stream?.destroy();
  }
}

function detectMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

async function toUploadable(filePath) {
  const resolved = await assertLocalFile(filePath);
  return toFile(createReadStream(resolved), path.basename(resolved), {
    type: detectMimeType(resolved),
  });
}

function buildClient(invocation) {
  return new OpenAI({
    apiKey: invocation.apiKey,
    baseURL: invocation.baseURL,
    timeout: invocation.timeoutMs,
  });
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

  if (invocation.background !== undefined) {
    payload.background = invocation.background;
  }
  if (invocation.outputCompression !== undefined) {
    payload.output_compression = invocation.outputCompression;
  }
  if (invocation.user !== undefined) {
    payload.user = invocation.user;
  }

  return payload;
}

export async function resolveInvocation(command, cliOptions, { cwd, env }) {
  const configFile = cliOptions.config ? await readConfigFile(cliOptions.config, cwd) : {};
  const envConfig = readEnvironmentConfig(env);
  const discoveredCredentials = await readDiscoveredCredentials(env);
  const merged = mergeDefinedObjects(discoveredCredentials, configFile, envConfig, cliOptions);
  const defaultSize = command === "generate" ? DEFAULT_GENERATE_SIZE : DEFAULT_EDIT_SIZE;

  const images = parseStringArray(cliOptions.image.length > 0 ? cliOptions.image : merged.image);
  const invocation = {
    command,
    cwd,
    apiKey: parseString(merged.apiKey, undefined),
    baseURL: trimTrailingSlash(parseString(merged.baseURL, DEFAULT_BASE_URL)),
    model: parseString(merged.model, "gpt-image-2"),
    prompt: parseString(merged.prompt, undefined),
    output: parseString(merged.output, undefined),
    outputFormat: validateChoice(parseString(merged.outputFormat, "png"), "outputFormat", [
      "png",
      "jpeg",
      "webp",
    ]),
    quality: validateChoice(parseString(merged.quality, "auto"), "quality", [
      "auto",
      "low",
      "medium",
      "high",
    ]),
    size: parseString(merged.size, defaultSize),
    background: validateChoice(parseString(merged.background, "auto"), "background", [
      "auto",
      "opaque",
      "transparent",
    ]),
    moderation: validateChoice(parseString(merged.moderation, "auto"), "moderation", [
      "auto",
      "low",
    ]),
    inputFidelity: validateChoice(parseString(merged.inputFidelity, undefined), "inputFidelity", [
      "low",
      "high",
    ]),
    outputCompression: parseInteger(merged.outputCompression, "outputCompression", {
      min: 0,
      max: 100,
      fallback: undefined,
    }),
    n: parseInteger(merged.n, "n", { min: 1, max: 10, fallback: 1 }),
    timeoutMs: parseInteger(merged.timeoutMs, "timeoutMs", {
      min: 1000,
      max: 600000,
      fallback: 180000,
    }),
    overwrite: parseBoolean(merged.overwrite, false),
    mask: parseString(merged.mask, undefined),
    user: parseString(merged.user, undefined),
    images,
  };

  if (!invocation.apiKey) {
    throw new Error(
      "Missing API key. Auto-discovery only works when the current or selected provider base_url hostname ends with claudecodes.org or niucodes.com. In API login, the skill reuses auth.json openai_api_key. In account login, the skill reuses the provider experimental_bearer_token. Otherwise provide a valid API key via --api-key, OPENAI_API_KEY, config.json apiKey, or persist it into the first-body-line API_KEY in SKILL.md by running scripts/set-skill-api-key.mjs after asking the user in chat.",
    );
  }
  if (!invocation.prompt) {
    throw new Error("Missing prompt. Pass --prompt.");
  }
  if (invocation.outputCompression !== undefined && invocation.outputFormat === "png") {
    throw new Error("outputCompression is only supported with jpeg or webp output.");
  }
  if (command === "generate" && invocation.images.length > 0) {
    throw new Error("generate does not accept --image.");
  }
  if (command === "generate" && invocation.mask) {
    throw new Error("generate does not accept --mask.");
  }
  if (command === "generate" && invocation.inputFidelity) {
    throw new Error("generate does not accept --input-fidelity.");
  }
  if (command === "edit" && invocation.images.length === 0) {
    throw new Error("edit requires at least one --image <local-path>.");
  }
  if (invocation.model.startsWith("gpt-image-2") && invocation.inputFidelity) {
    throw new Error("gpt-image-2 requires omitting inputFidelity because the API fixes image fidelity at high.");
  }
  if (invocation.model.startsWith("gpt-image-2") && invocation.background === "transparent") {
    throw new Error("gpt-image-2 does not support background=transparent.");
  }

  return invocation;
}

export async function createImageRequest(invocation) {
  const client = buildClient(invocation);
  const payload = applySharedPayload(invocation);

  if (invocation.command === "generate") {
    return client.images.generate(payload);
  }

  const imageUploads = await Promise.all(invocation.images.map((filePath) => toUploadable(path.resolve(invocation.cwd, filePath))));
  const editPayload = {
    ...payload,
    image: imageUploads.length === 1 ? imageUploads[0] : imageUploads,
  };

  if (invocation.mask) {
    editPayload.mask = await toUploadable(path.resolve(invocation.cwd, invocation.mask));
  }
  if (invocation.inputFidelity) {
    editPayload.input_fidelity = invocation.inputFidelity;
  }

  return client.images.edit(editPayload);
}

export function formatOpenAIError(error) {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const parts = [];
  if (error.message) {
    parts.push(String(error.message));
  }
  if (error.code) {
    parts.push(`code=${error.code}`);
  }
  if (error.status) {
    parts.push(`status=${error.status}`);
  }
  if (error.request_id) {
    parts.push(`request_id=${error.request_id}`);
  }

  const moderationDetails = error.moderation_details ?? error.body?.moderation_details;
  if (moderationDetails?.categories?.length) {
    parts.push(`moderation_categories=${moderationDetails.categories.join(",")}`);
  }
  if (moderationDetails?.moderation_stage) {
    parts.push(`moderation_stage=${moderationDetails.moderation_stage}`);
  }

  if (parts.length === 0) {
    return JSON.stringify(error);
  }
  return parts.join(" | ");
}
