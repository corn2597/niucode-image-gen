import { stat } from "node:fs/promises";
import process from "node:process";

import { createImageRequest, formatOpenAIError, resolveInvocation } from "./image-client.mjs";
import {
  buildRenderables,
  resolveOutputTargets,
  saveImageItems,
  stableStringify,
} from "./output.mjs";

const HELP_TEXT = `niucodes-image-gen

Usage:
  node <skill-dir>/scripts/niucodes-image-gen.mjs generate --prompt "..." --api-key "<key>" [options]
  node <skill-dir>/scripts/niucodes-image-gen.mjs edit --image "<path>" --prompt "..." --api-key "<key>" [options]

Commands:
  generate    Call /v1/images/generations through the official OpenAI Node SDK.
  edit        Call /v1/images/edits through the official OpenAI Node SDK.

Common options:
  --config <path>               Load JSON config. CLI flags override config values.
  --api-key <key>               API key. Falls back to OPENAI_API_KEY.
  --base-url <url>              SDK baseURL. Falls back to OPENAI_BASE_URL.
  --model <model>               Defaults to gpt-image-2 or OPENAI_IMAGE_MODEL.
  --output <file-or-dir>        Output file or directory. Defaults to ./image-outputs/.
  --output-format <fmt>         png | jpeg | webp
  --quality <value>             auto | low | medium | high
  --size <value>                auto or a supported size such as 1024x1024
  --background <value>          auto | opaque | transparent
  --moderation <value>          auto | low
  --n <count>                   Number of images to save. Default: 1
  --overwrite                   Overwrite the first output path if it already exists.
  --timeout-ms <ms>             SDK timeout in milliseconds. Default: 180000

Edit-only options:
  --image <path>                Repeat to upload multiple local reference images.
  --mask <path>                 Optional local mask image path.
  --input-fidelity <value>      low | high. Omit for gpt-image-2.

Display rule:
  The script prints JSON with saved[*].markdown. Reuse those markdown strings in the final answer
  so Codex, VS Code surfaces, and similar clients can render the saved local image files.
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

function buildResponse(invocation, targets, savedItems, apiResponse) {
  const renderables = buildRenderables(savedItems, invocation.command);
  return {
    command: invocation.command,
    model: invocation.model,
    base_url: invocation.baseURL ?? "https://api.openai.com/v1",
    request: {
      prompt: invocation.prompt,
      image_count: invocation.images.length,
      mask: invocation.mask ?? null,
      size: invocation.size,
      quality: invocation.quality,
      background: invocation.background,
      moderation: invocation.moderation,
      output_format: invocation.outputFormat,
      output_compression: invocation.outputCompression ?? null,
      input_fidelity: invocation.inputFidelity ?? null,
      n: invocation.n,
      output: invocation.output ?? null,
      overwrite: invocation.overwrite,
    },
    saved: renderables,
    response: {
      request_id: apiResponse?._request_id ?? null,
      revised_prompt: apiResponse?.data?.[0]?.revised_prompt ?? null,
      raw_item_count: Array.isArray(apiResponse?.data) ? apiResponse.data.length : targets.length,
    },
    render_hint:
      "Paste each saved[*].markdown string into the final answer to render the saved images in Codex or compatible VS Code surfaces.",
  };
}

export async function runCli(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }

  if (!["generate", "edit"].includes(parsed.command)) {
    throw new Error(`Unsupported command: ${parsed.command}`);
  }

  const invocation = await resolveInvocation(parsed.command, parsed.options, { cwd, env });

  try {
    const apiResponse = await createImageRequest(invocation);
    const outputTargets = await resolveOutputTargets({
      command: invocation.command,
      cwd,
      model: invocation.model,
      output: invocation.output,
      outputFormat: invocation.outputFormat,
      overwrite: invocation.overwrite,
      count: Array.isArray(apiResponse?.data) && apiResponse.data.length > 0 ? apiResponse.data.length : invocation.n,
    });

    const savedItems = await saveImageItems(apiResponse, outputTargets, invocation.timeoutMs);
    const payload = buildResponse(invocation, outputTargets, savedItems, apiResponse);

    process.stdout.write(`${stableStringify(payload)}\n`);
    return 0;
  } catch (error) {
    if (invocation.output) {
      const outputExists = await fileExists(invocation.output);
      if (outputExists) {
        process.stderr.write(`Output target already exists: ${invocation.output}\n`);
      }
    }
    throw new Error(formatOpenAIError(error));
  }
}

export { HELP_TEXT, parseArgs };
