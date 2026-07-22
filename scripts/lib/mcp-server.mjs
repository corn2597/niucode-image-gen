import readline from "node:readline";
import process from "node:process";

import { executeImageCommand } from "./cli.mjs";

const PROTOCOL_VERSION = "2024-11-05";

const COMMON_PROPERTIES = {
  prompt: { type: "string", minLength: 1 },
  output: { type: "string", minLength: 1, description: "Absolute local output file path outside the skill package." },
  model: { type: "string" },
  quality: { type: "string", enum: ["auto", "low", "medium", "high"] },
  size: { type: "string" },
  outputFormat: { type: "string", enum: ["png", "jpeg", "webp"] },
  background: { type: "string", enum: ["auto", "opaque", "transparent"] },
  moderation: { type: "string", enum: ["auto", "low"] },
  outputCompression: { type: "integer", minimum: 0, maximum: 100 },
  n: { type: "integer", minimum: 1, maximum: 10 },
  overwrite: {
    type: "boolean",
    default: true,
    description: "Overwrite the requested output file. Defaults to true so a successful call always saves to the exact requested path.",
  },
  timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
};

const TOOLS = [
  {
    name: "imagegen_generate",
    description: "Generate images through the configured OpenAI Images API. Prompt is forwarded unchanged. Returns local saved image paths and timing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt", "output"],
      properties: COMMON_PROPERTIES,
    },
  },
  {
    name: "imagegen_edit",
    description: "Edit local source images through the configured OpenAI Images API. Prompt and source image paths are forwarded unchanged.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt", "output", "images"],
      properties: {
        ...COMMON_PROPERTIES,
        images: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
          description: "One or more absolute local source image paths.",
        },
        mask: { type: "string", minLength: 1 },
        inputFidelity: { type: "string", enum: ["low", "high"] },
      },
    },
  },
];

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function mcpPayload(payload) {
  const saved = payload.saved.map(({ index, absolute_path, markdown }) => ({ index, absolute_path, markdown }));
  return {
    status: payload.status,
    command: payload.command,
    exit_code: payload.exit_code,
    saved,
    // A single ready-to-copy field avoids a post-call path or rendering decision.
    render: saved.map((item) => item.markdown).join("\n"),
    timing_ms: payload.timing_ms,
    error: payload.error,
    request_id: payload.request_id,
  };
}

function finalAnswerText(result) {
  if (result.status === "success") {
    return `exit_code: ${result.exit_code}\ntiming_ms: ${JSON.stringify(result.timing_ms)}\n${result.render}`;
  }
  return `exit_code: ${result.exit_code}\ntiming_ms: ${JSON.stringify(result.timing_ms)}\nerror: ${result.error?.message ?? "Image request failed."}`;
}

function contentResult(payload, isError = false) {
  const result = mcpPayload(payload);
  result.final_answer = finalAnswerText(result);
  return {
    // The model can return this text verbatim, including the local image Markdown.
    content: [{ type: "text", text: result.final_answer }],
    structuredContent: result,
    isError,
  };
}

function failurePayload(command, error) {
  return {
    status: "failed",
    command,
    exit_code: 1,
    saved: [],
    timing_ms: {},
    error: { message: error instanceof Error ? error.message : String(error) },
    request_id: null,
  };
}

function invocationOptions(command, args) {
  // MCP callers provide an exact destination path. Preserve that contract even
  // when a previous image exists, rather than causing the agent to resolve a
  // generated suffix after the request completes.
  const options = { ...args, overwrite: args.overwrite ?? true, image: [] };
  if (command === "edit") {
    options.image = Array.isArray(args.images) ? args.images : [];
    delete options.images;
  }
  return options;
}

async function callImageTool(name, args, cwd) {
  if (name === "imagegen_generate") {
    return executeImageCommand("generate", invocationOptions("generate", args), { cwd });
  }
  if (name === "imagegen_edit") {
    return executeImageCommand("edit", invocationOptions("edit", args), { cwd });
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function createMcpRequestHandler({ cwd = process.cwd() } = {}) {
  return async function handle(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return;
    }
    const { id, method, params = {} } = message;
    if (method === "notifications/initialized") return;
    if (method === "initialize") {
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "niucodes-image-gen", version: "1.1.2" },
      });
      return;
    }
    if (method === "tools/list") {
      respond(id, { tools: TOOLS });
      return;
    }
    if (method === "tools/call") {
      const command = params.name === "imagegen_edit" ? "edit" : "generate";
      const toolStartedAt = performance.now();
      try {
        const payload = await callImageTool(params.name, params.arguments ?? {}, cwd);
        const mcpTotalMs = Math.round(performance.now() - toolStartedAt);
        payload.timing_ms.mcp = {
          dispatch: Math.max(0, mcpTotalMs - payload.timing_ms.total),
          total: mcpTotalMs,
        };
        respond(id, contentResult(payload));
      } catch (error) {
        respond(id, contentResult(failurePayload(command, error), true));
      }
      return;
    }
    if (id !== undefined) {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  };
}

export async function runMcpServer({ cwd = process.cwd() } = {}) {
  const handle = createMcpRequestHandler({ cwd });
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      await handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`Invalid MCP message: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

export { TOOLS };
