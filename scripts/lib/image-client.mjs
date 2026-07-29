import { readFile, realpath, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Agent, ProxyAgent, fetch } from "undici";

export const DEFAULT_BASE_URL = "https://api-direct.claudecodes.org/v1";
export const DEFAULT_GENERATE_SIZE = "1024x1024";
export const DEFAULT_EDIT_SIZE = "auto";
export const DEFAULT_TIMEOUT_MS = 600000;
const MAX_STREAM_BYTES = 100 * 1024 * 1024;
const MAX_INPUT_IMAGES = 8;
const MAX_INPUT_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 50 * 1024 * 1024;

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

function parseProxyUrl(value) {
  const proxyUrl = parseString(value, undefined);
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('unsupported protocol');
    }
    return parsed.toString();
  } catch {
    throw new Error('proxyUrl must be a valid http or https URL.');
  }
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

export function defaultOutputDirectory({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  // This directory is persistent user application data, not a system temp
  // directory. It is the most reliable fallback when Codex has no workspace.
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    return platformPath.join(env.LOCALAPPDATA || platformPath.join(home, "AppData", "Local"), "niucodes-image-gen", "outputs");
  }
  if (platform === "darwin") {
    return platformPath.join(home, "Library", "Application Support", "niucodes-image-gen", "outputs");
  }
  return platformPath.join(env.XDG_DATA_HOME || platformPath.join(home, ".local", "share"), "niucodes-image-gen", "outputs");
}

export function legacyPicturesOutputDirectory({ home = os.homedir(), platform = process.platform } = {}) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(home, "Pictures", "niucodes-image-gen");
}

async function canonicalPath(value) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function systemTemporaryRoots(platform = process.platform, env = process.env) {
  const roots = [os.tmpdir(), env.TMPDIR, env.TMP, env.TEMP].filter(Boolean);
  if (platform === "darwin") roots.push("/tmp", "/private/tmp", "/var/folders", "/private/var/folders");
  if (platform === "linux") roots.push("/tmp", "/var/tmp");
  if (platform === "win32") {
    roots.push(
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Temp"),
      env.SystemRoot && path.join(env.SystemRoot, "Temp"),
    );
  }
  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))];
}

async function taskOutputDirectory(cwd, skillRoot) {
  const rawCwd = path.resolve(cwd);
  const resolvedCwd = await canonicalPath(rawCwd);
  const rawSkillRoot = path.resolve(skillRoot);
  const resolvedSkillRoot = await canonicalPath(rawSkillRoot);
  // A packaged executable is normally launched from a Codex task workspace.
  // Never treat the installed skill itself as a task workspace.
  // System temp locations are not durable task workspaces. The caller falls
  // back to a persistent user-owned application directory instead.
  if (isPathWithin(rawSkillRoot, rawCwd) || isPathWithin(resolvedSkillRoot, resolvedCwd)) return undefined;
  for (const temporaryRoot of systemTemporaryRoots()) {
    if (isPathWithin(temporaryRoot, rawCwd) || isPathWithin(await canonicalPath(temporaryRoot), resolvedCwd)) return undefined;
  }
  return path.join(resolvedCwd, "image-outputs", "niucodes-image-gen");
}

async function workspaceOutputDirectory(workspace) {
  // `workspace` is an explicit request field supplied by Codex. It remains
  // authoritative even when an integration happens to mount a workspace
  // under a temporary root. Only an implicit process CWD is filtered above.
  return path.join(await canonicalPath(path.resolve(workspace)), "image-outputs", "niucodes-image-gen");
}

function appendUniquePath(paths, candidate, cwd = process.cwd()) {
  if (!candidate) return;
  const resolved = path.resolve(cwd, candidate);
  if (!paths.some((existing) => path.resolve(existing) === resolved)) paths.push(resolved);
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

async function assertLocalFile(filePath, inputState) {
  const resolved = path.resolve(filePath);
  try {
    const entry = await stat(resolved);
    if (!entry.isFile()) throw new Error("not a regular file");
    if (entry.size > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(`exceeds the ${MAX_INPUT_IMAGE_BYTES} byte per-file limit`);
    }
    if (inputState) {
      inputState.totalBytes += entry.size;
      if (inputState.totalBytes > MAX_TOTAL_INPUT_BYTES) {
        throw new Error(`exceeds the ${MAX_TOTAL_INPUT_BYTES} byte total limit`);
      }
    }
    return resolved;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read image file: ${resolved} (${detail})`);
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

async function readUploadable(filePath, inputState) {
  const resolved = await assertLocalFile(filePath, inputState);
  return {
    bytes: await readFile(resolved),
    filename: path.basename(resolved),
    mimeType: detectMimeType(resolved),
  };
}

function escapeMultipartHeaderValue(value) {
  // A local filename must not be able to inject another multipart header.
  return String(value).replace(/[\r\n"]/g, "_");
}

function multipartTextPart(boundary, key, value) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartHeaderValue(key)}"\r\n\r\n${String(value)}\r\n`,
    "utf8",
  );
}

function multipartFilePart(boundary, key, file) {
  return [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartHeaderValue(key)}"; filename="${escapeMultipartHeaderValue(file.filename)}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      "utf8",
    ),
    file.bytes,
    Buffer.from("\r\n", "utf8"),
  ];
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

function createRequestLifecycle(timeoutMs) {
  const controller = new AbortController();
  let abortMessage = null;
  let abortCode = null;
  let abortListener = null;

  const abort = (message, code = "request_cancelled") => {
    if (abortMessage) return;
    abortMessage = message;
    abortCode = code;
    controller.abort();
    abortListener?.();
  };
  const onSignal = (signalName) => abort(`Image request cancelled by ${signalName}.`);
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  const timeout = setTimeout(() => abort(`Image request timed out after ${timeoutMs}ms.`, "timeout"), timeoutMs);

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return {
    signal: controller.signal,
    addAbortListener(listener) {
      abortListener = listener;
      if (abortMessage) listener();
    },
    throwIfAborted() {
      if (abortMessage) {
        const error = new Error(abortMessage);
        error.code = abortCode ?? "request_cancelled";
        throw error;
      }
    },
    dispose() {
      clearTimeout(timeout);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      abortListener = null;
    },
  };
}

function completedEventType(command) {
  return command === "generate" ? "image_generation.completed" : "image_edit.completed";
}

function partialEventType(command) {
  return command === "generate" ? "image_generation.partial_image" : "image_edit.partial_image";
}

class ImageHttpError extends Error {
  constructor(message, { status, requestId, code, cause, deliveryUnknown = false, phase } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ImageHttpError";
    if (status !== undefined) this.status = status;
    if (requestId) this.request_id = requestId;
    if (code) this.code = code;
    this.deliveryUnknown = deliveryUnknown;
    if (phase) this.phase = phase;
  }
}

function parseCompletedPayload(payload, expectedCompletedType) {
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return null;
  }
  if (event?.type !== expectedCompletedType) return null;
  if (typeof event.b64_json !== "string" || event.b64_json.length === 0) {
    throw new Error("Image stream completed without image data.");
  }
  return event;
}

function extractDataPayload(line) {
  if (!line.startsWith("data:")) return null;
  return line.slice(5).replace(/^ /, "");
}

async function consumeImageStream(response, invocation, lifecycle) {
  if (!response.body) throw new ImageHttpError("Image API returned an empty response body.", { status: response.status });

  const decoder = new TextDecoder("utf-8");
  const reader = response.body.getReader();
  const expectedCompletedType = completedEventType(invocation.command);
  const expectedPartialType = partialEventType(invocation.command);
  const dataLines = [];
  let pending = "";
  let firstByteMs = null;
  let partialEventCount = 0;
  let byteCount = 0;

  const inspectPayload = (payload, frameTerminated) => {
    if (!payload || payload === "[DONE]") return null;
    const completed = parseCompletedPayload(payload, expectedCompletedType);
    if (completed) {
      return {
        completed: [{ b64_json: completed.b64_json, revised_prompt: completed.revised_prompt ?? null }],
        firstByteMs,
        completedPayloadMs: Math.round(performance.now()),
        completedFrameTerminated: frameTerminated,
        partialEventCount,
      };
    }
    try {
      const event = JSON.parse(payload);
      if (event?.type === expectedPartialType) {
        partialEventCount += 1;
        return null;
      }
      if (event?.type) {
        throw new Error(`Image stream returned an unsupported event: ${String(event.type)}.`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
    return null;
  };

  const inspectOpenFrame = () => {
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") return null;
    const completed = parseCompletedPayload(payload, expectedCompletedType);
    if (!completed) return null;
    return {
      completed: [{ b64_json: completed.b64_json, revised_prompt: completed.revised_prompt ?? null }],
      firstByteMs,
      completedPayloadMs: Math.round(performance.now()),
      completedFrameTerminated: false,
      partialEventCount,
    };
  };
  const processLine = (line) => {
    if (line === "") {
      const result = inspectPayload(dataLines.join("\n"), true);
      dataLines.length = 0;
      return result;
    }
    const data = extractDataPayload(line);
    if (data !== null) {
      dataLines.push(data);
      // Some proxies transmit a syntactically complete JSON event but never
      // append the blank SSE frame delimiter. A valid completed payload is
      // sufficient to persist the final image immediately.
      return inspectOpenFrame();
    }
    return null;
  };

  lifecycle.addAbortListener(() => {
    void reader.cancel().catch(() => undefined);
  });

  try {
    for (;;) {
      lifecycle.throwIfAborted();
      const { done, value } = await reader.read();
      lifecycle.throwIfAborted();
      if (done) break;
      if (firstByteMs === null) firstByteMs = Math.round(performance.now());
      byteCount += value.byteLength;
      if (byteCount > MAX_STREAM_BYTES) {
        throw new Error(`Image stream exceeded the ${MAX_STREAM_BYTES} byte limit.`);
      }
      pending += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = pending.indexOf("\n")) !== -1) {
        const rawLine = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        const completed = processLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
        if (completed) return completed;
      }

      // Also allow a completed `data:` JSON object that ends exactly at a
      // transport chunk boundary without either an LF or a blank SSE line.
      const pendingData = extractDataPayload(pending);
      const completed = pendingData === null
        ? inspectOpenFrame()
        : (() => {
          dataLines.push(pendingData);
          const result = inspectOpenFrame();
          dataLines.pop();
          return result;
        })();
      if (completed) return completed;
    }

    pending += decoder.decode();
    if (pending) {
      const completed = processLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
      if (completed) return completed;
    }
    const completed = inspectPayload(dataLines.join("\n"), false);
    if (completed) return completed;
  } finally {
    // A completed Base64 payload is terminal. Do not wait for an upstream
    // proxy to close its SSE socket. Await Undici's local cancellation so no
    // active stream handle keeps the packaged executable alive after stdout
    // has the final JSON result.
    await reader.cancel().catch(() => undefined);
  }

  throw new Error("Image stream ended without an image_generation.completed or image_edit.completed event.");
}

export async function resolveInvocation(command, cliOptions, { cwd = process.cwd() } = {}) {
  const config = await readConfigFile(cliOptions.config, cwd);
  const merged = mergeDefinedObjects(config, cliOptions);
  const defaultSize = command === "generate" ? DEFAULT_GENERATE_SIZE : DEFAULT_EDIT_SIZE;
  const images = parseStringArray(cliOptions.image.length > 0 ? cliOptions.image : merged.image);
  const workspace = cliOptions.workspace === undefined || cliOptions.workspace === null || cliOptions.workspace === ""
    ? undefined
    : String(cliOptions.workspace);
  if (workspace !== undefined && !path.isAbsolute(workspace)) {
    throw new Error("workspace must be an absolute path.");
  }
  const configuredOutput = parseString(config.defaultOutputDir, undefined);
  const skillRoot = resolveSkillRoot();
  const explicitOutput = parseString(merged.output, undefined);
  const outputCandidates = [];
  if (!explicitOutput) {
    if (workspace) appendUniquePath(outputCandidates, await workspaceOutputDirectory(workspace), cwd);
    appendUniquePath(outputCandidates, await taskOutputDirectory(cwd, skillRoot), cwd);
    appendUniquePath(outputCandidates, configuredOutput, cwd);
    // Prefer a visible, user-owned directory when Codex has no workspace.
    // Controlled Folder Access can deny Pictures on Windows, so the durable
    // application-data directory remains the final non-temp fallback.
    appendUniquePath(outputCandidates, legacyPicturesOutputDirectory(), cwd);
    appendUniquePath(outputCandidates, defaultOutputDirectory(), cwd);
  }
  const defaultOutput = outputCandidates[0] ?? defaultOutputDirectory();
  const invocation = {
    command,
    cwd,
    apiKey: parseString(config.apiKey, undefined),
    baseURL: trimTrailingSlash(parseString(merged.baseURL, DEFAULT_BASE_URL)),
    // Proxy credentials, if any, remain in config.json and are never accepted
    // from the request file or emitted in a result.
    proxyUrl: parseProxyUrl(config.proxyUrl),
    model: parseString(merged.model, "gpt-image-2"),
    prompt: parsePrompt(merged.prompt),
    output: explicitOutput ?? defaultOutput,
    outputIsDirectory: explicitOutput === undefined,
    outputCandidates: explicitOutput ? [path.resolve(cwd, explicitOutput)] : outputCandidates,
    explicitOutput: explicitOutput !== undefined,
    outputFormat: validateChoice(parseString(merged.outputFormat, "png"), "outputFormat", ["png", "jpeg", "webp"]),
    quality: validateChoice(parseString(merged.quality, "auto"), "quality", ["auto", "low", "medium", "high"]),
    size: parseString(merged.size, defaultSize),
    background: validateChoice(parseString(merged.background, "auto"), "background", ["auto", "opaque", "transparent"]),
    moderation: validateChoice(parseString(merged.moderation, "auto"), "moderation", ["auto", "low"]),
    inputFidelity: validateChoice(parseString(merged.inputFidelity, undefined), "inputFidelity", ["low", "high"]),
    outputCompression: parseInteger(merged.outputCompression, "outputCompression", { min: 0, max: 100 }),
    n: parseInteger(merged.n, "n", { min: 1, max: 1, fallback: 1 }),
    // The configured timeout is the actual request deadline. A completed
    // image received before it is always saved and reported, even if that
    // final local write crosses the deadline by a few milliseconds.
    timeoutMs: parseInteger(merged.timeoutMs, "timeoutMs", { min: 1000, max: 600000, fallback: DEFAULT_TIMEOUT_MS }),
    overwrite: parseBoolean(merged.overwrite, false),
    mask: parseString(merged.mask, undefined),
    user: parseString(merged.user, undefined),
    images,
    workspace: workspace ? path.resolve(workspace) : undefined,
  };

  if (!invocation.prompt) throw new Error("Missing prompt. Pass --prompt.");
  if (!invocation.apiKey) throw new Error("Missing apiKey in config.json.");
  const outputPath = path.resolve(cwd, invocation.output);
  if (isPathWithin(resolveSkillRoot(), outputPath)) {
    const error = new Error("Output must be outside the skill directory. Pass an output path in a user-owned location.");
    error.code = "output_permission_denied";
    error.phase = "output";
    throw error;
  }

  if (invocation.outputCompression !== undefined && invocation.outputFormat === "png") {
    throw new Error("outputCompression is only supported with jpeg or webp output.");
  }
  if (command === "generate" && invocation.images.length > 0) throw new Error("generate does not accept --image.");
  if (command === "generate" && invocation.mask) throw new Error("generate does not accept --mask.");
  if (command === "generate" && invocation.inputFidelity) throw new Error("generate does not accept --input-fidelity.");
  if (command === "edit" && invocation.images.length === 0) throw new Error("edit requires at least one --image <local-path>.");
  if (invocation.images.length > MAX_INPUT_IMAGES) {
    throw new Error(`edit supports at most ${MAX_INPUT_IMAGES} input images.`);
  }
  return invocation;
}

function definedJsonPayload(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

async function createRequestBody(invocation) {
  const payload = {
    ...applySharedPayload(invocation),
    // The API emits exactly one final image event. Extra partial previews add
    // image output tokens and do not make the final result available sooner.
    stream: true,
    partial_images: 0,
  };
  if (invocation.command === "generate") {
    return { body: JSON.stringify(definedJsonPayload(payload)), contentType: "application/json" };
  }

  const preparationStartedAt = performance.now();
  const boundary = `----niucodes-image-gen-${randomBytes(18).toString("hex")}`;
  const chunks = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) chunks.push(multipartTextPart(boundary, key, value));
  }
  const inputState = { totalBytes: 0 };
  for (const filePath of invocation.images) {
    chunks.push(...multipartFilePart(boundary, "image", await readUploadable(path.resolve(invocation.cwd, filePath), inputState)));
  }
  if (invocation.mask) {
    chunks.push(...multipartFilePart(boundary, "mask", await readUploadable(path.resolve(invocation.cwd, invocation.mask), inputState)));
  }
  if (invocation.inputFidelity) chunks.push(multipartTextPart(boundary, "input_fidelity", invocation.inputFidelity));
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
    inputPrepareMs: Math.round(performance.now() - preparationStartedAt),
  };
}

function requestIdFromResponse(response) {
  return response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? null;
}

async function responseError(response, requestId) {
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  let message;
  if (contentType.includes("json")) {
    try {
      const parsed = JSON.parse(body);
      message = parsed?.error?.message ?? parsed?.message;
    } catch {
      // The bounded plain-text fallback below is sufficient for invalid JSON.
    }
  }
  message ??= body.trim().slice(0, 1000) || `Image API returned HTTP ${response.status}.`;
  return new ImageHttpError(message, { status: response.status, requestId });
}

async function createTransport(proxyUrl) {
  // Never use fetch's global dispatcher for a one-shot executable. Its idle
  // keep-alive socket can keep the packaged Node event loop alive long after a
  // completed Base64 image has already been written to disk.
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent();
  return {
    dispatcher,
    async close() {
      // destroy() tears down a streaming or idle keep-alive socket immediately.
      // close() may otherwise wait for the peer EOF after a completed image event.
      await dispatcher.destroy(new Error("Image stream completed or terminated.")).catch(() => undefined);
    },
  };
}

export async function createImageRequest(invocation, { clientRequestId } = {}) {
  const transport = await createTransport(invocation.proxyUrl);
  let lifecycle;
  try {
    let requestBody;
    try {
      requestBody = await createRequestBody(invocation);
    } catch (error) {
      error.phase = "input";
      throw error;
    }
    const { body, contentType, inputPrepareMs = 0 } = requestBody;
    // Input validation and local file preparation do not consume the actual
    // configured API deadline. Once fetch begins, the request gets its full
    // ten-minute budget.
    lifecycle = createRequestLifecycle(invocation.timeoutMs);
    lifecycle.throwIfAborted();
    const apiStartedAt = performance.now();
    let response;
    try {
      response = await fetch(`${invocation.baseURL}/images/${invocation.command === "generate" ? "generations" : "edits"}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${invocation.apiKey ?? ""}`,
          "X-Niucodes-Client-Request-Id": clientRequestId,
          ...(contentType ? { "Content-Type": contentType } : {}),
        },
        body,
        signal: lifecycle.signal,
        dispatcher: transport.dispatcher,
      });
    } catch (error) {
      lifecycle.throwIfAborted();
      throw new ImageHttpError("Image API connection error.", {
        code: error?.cause?.code ?? error?.code,
        cause: error,
        deliveryUnknown: true,
        phase: "upload_or_delivery_unknown",
      });
    }
    const requestId = requestIdFromResponse(response);
    if (!response.ok) {
      const error = await responseError(response, requestId);
      error.phase = "response_incomplete";
      throw error;
    }
    let consumed;
    try {
      consumed = await consumeImageStream(response, invocation, lifecycle);
    } catch (error) {
      error.phase ??= "response_incomplete";
      throw error;
    }
    return {
      response: { data: consumed.completed, _request_id: requestId },
      inputPrepareMs,
      apiDurationMs: Math.round(performance.now() - apiStartedAt),
      streamFirstByteMs: consumed.firstByteMs === null ? null : Math.max(0, consumed.firstByteMs - Math.round(apiStartedAt)),
      streamCompletedPayloadMs: Math.max(0, consumed.completedPayloadMs - Math.round(apiStartedAt)),
      streamCompletedFrameTerminated: consumed.completedFrameTerminated,
      streamPartialEventCount: consumed.partialEventCount,
    };
  } catch (error) {
    try {
      lifecycle.throwIfAborted();
    } catch (abortError) {
      // Preserve the phase in which cancellation happened. Otherwise an
      // abort while reading a received SSE response looks like a connection
      // failure before upload completed.
      abortError.phase = error?.phase ?? "upload_or_delivery_unknown";
      throw abortError;
    }
    throw error;
  } finally {
    lifecycle?.dispose();
    await transport.close();
  }
}

function transportCause(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const code = typeof current.code === "string" && /^[A-Z0-9_]+$/.test(current.code)
      ? current.code
      : undefined;
    const name = typeof current.name === "string" && /^[A-Za-z0-9_]+$/.test(current.name)
      ? current.name
      : undefined;
    if (code || (depth > 0 && name)) return { ...(name ? { name } : {}), ...(code ? { code } : {}) };
    current = current.cause;
  }
  return undefined;
}

export function isRequestDeliveryUnknown(error) {
  return error?.deliveryUnknown === true;
}

export function describeOpenAIError(error) {
  const transport = transportCause(error);
  return {
    message: formatOpenAIError(error),
    ...(isRequestDeliveryUnknown(error) ? { kind: "request_delivery_unknown" } : {}),
    ...(transport ? { transport } : {}),
  };
}

export function formatOpenAIError(error) {
  if (!error || typeof error !== "object") return String(error);
  const transport = transportCause(error);
  return [error.message, error.code && `code=${error.code}`, error.status && `status=${error.status}`, error.request_id && `request_id=${error.request_id}`, transport?.code && `transport=${transport.code}`]
    .filter(Boolean)
    .join(" | ") || JSON.stringify(error);
}
