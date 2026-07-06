import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import {
  DEFAULT_BASE_URL,
  DEFAULT_EDIT_SIZE,
  DEFAULT_GENERATE_SIZE,
  resolveInvocation,
} from "../lib/image-client.mjs";
import {
  SKILL_API_KEY_PLACEHOLDER,
  extractStoredSkillApiKey,
} from "../lib/skill-api-key.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve("scripts/niucodes-image-gen.mjs");
const setterScriptPath = path.resolve("scripts/set-skill-api-key.mjs");
const repoRoot = path.resolve(".");
const fixturePngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s4Xv2QAAAAASUVORK5CYII=";
const testSkillMdTemplate = `---
name: niucodes-image-gen
description: Thin API-forwarding wrapper for OpenAI-compatible image generation and editing.
---
API_KEY: ${SKILL_API_KEY_PLACEHOLDER}

# niucodes image gen
`;

const tempDirectories = [];

afterEach(async () => {
  while (tempDirectories.length > 0) {
    const dir = tempDirectories.pop();
    await import("node:fs/promises").then(({ rm }) =>
      rm(dir, {
        recursive: true,
        force: true,
      }),
    );
  }
});

async function createTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "niucodes-image-gen-"));
  tempDirectories.push(dir);
  return dir;
}

async function createTempSkillDir(skillContent = testSkillMdTemplate) {
  const rootDir = await createTempDir();
  const skillDir = path.join(rootDir, "skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), skillContent);
  return skillDir;
}

async function writePng(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(fixturePngBase64, "base64"));
}

async function createCodexHome(tempRoot, { authJson, configToml } = {}) {
  const codexHome = path.join(tempRoot, ".codex");
  await mkdir(codexHome, { recursive: true });

  if (authJson !== undefined) {
    await writeFile(path.join(codexHome, "auth.json"), JSON.stringify(authJson, null, 2));
  }

  if (configToml !== undefined) {
    await writeFile(path.join(codexHome, "config.toml"), configToml);
  }

  return codexHome;
}

function buildProviderConfigToml({
  modelProvider = "claude_provider",
  baseURL,
  experimentalBearerToken,
} = {}) {
  return [
    `model_provider = "${modelProvider}"`,
    "",
    `[model_providers.${modelProvider}]`,
    baseURL ? `base_url = "${baseURL}"` : null,
    experimentalBearerToken ? `experimental_bearer_token = "${experimentalBearerToken}"` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function runCli(args, { cwd = repoRoot, env = {} } = {}) {
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function captureCliFailure(args, options) {
  try {
    await runCli(args, options);
    assert.fail("Expected CLI command to fail");
  } catch (error) {
    return error;
  }
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  assert.ok(boundaryMatch, "multipart boundary should exist");
  const boundary = boundaryMatch[1] ?? boundaryMatch[2];
  const delimiter = `--${boundary}`;
  const bodyText = buffer.toString("latin1");
  const rawParts = bodyText
    .split(delimiter)
    .slice(1, -1)
    .map((part) => part.replace(/^\r\n/, "").replace(/\r\n$/, ""));

  return rawParts.map((part) => {
    const [rawHeaders, rawBody] = part.split("\r\n\r\n");
    const headerLines = rawHeaders.split("\r\n");
    const headers = {};
    for (const line of headerLines) {
      const separatorIndex = line.indexOf(":");
      const key = line.slice(0, separatorIndex).trim().toLowerCase();
      const value = line.slice(separatorIndex + 1).trim();
      headers[key] = value;
    }
    const disposition = headers["content-disposition"] ?? "";
    const nameMatch = /name="([^"]+)"/i.exec(disposition);
    const fileMatch = /filename="([^"]+)"/i.exec(disposition);
    return {
      name: nameMatch?.[1] ?? null,
      filename: fileMatch?.[1] ?? null,
      contentType: headers["content-type"] ?? null,
      body: rawBody.replace(/\r\n$/, ""),
    };
  });
}

async function withMockServer(routeHandler, run) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      try {
        await routeHandler(req, res, body);
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}`;

  try {
    await run({ baseURL, requests });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("skill structure files exist", async () => {
  const skillContent = await readFile(path.join(repoRoot, "SKILL.md"), "utf8");
  const openaiYaml = await readFile(path.join(repoRoot, "agents", "openai.yaml"), "utf8");

  assert.match(skillContent, /^---\r?\nname: niucodes-image-gen\r?\n/);
  assert.match(
    skillContent,
    /^---\r?\n[\s\S]*?\r?\n---\r?\nAPI_KEY:\s*\S+/m,
  );
  assert.match(skillContent, /Thin API-forwarding wrapper/);
  assert.match(skillContent, /ask the user in chat for a valid API key/i);
  assert.match(skillContent, /set-skill-api-key\.mjs/);
  assert.match(skillContent, /https:\/\/api-direct\.claudecodes\.org\/v1/);
  assert.match(skillContent, /claudecodes\.org/);
  assert.match(skillContent, /niucodes\.com/);
  assert.match(openaiYaml, /display_name: "niucodes image gen"/);
  assert.match(openaiYaml, /thin API wrapper/i);
});

test("generate command sends JSON request and saves renderable output", async () => {
  const tempDir = await createTempDir();
  const outputPath = path.join(tempDir, "generated.png");

  await withMockServer(
    async (req, res, body) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/images/generations");
      assert.match(req.headers["authorization"], /^Bearer test-key$/);
      assert.match(req.headers["content-type"], /^application\/json/);
      const parsed = JSON.parse(body.toString("utf8"));
      assert.equal(parsed.model, "gpt-image-2");
      assert.equal(parsed.prompt, "paint a tiny blue fox");
      assert.equal(parsed.output_format, "png");
      assert.equal(parsed.size, DEFAULT_GENERATE_SIZE);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              b64_json: fixturePngBase64,
              revised_prompt: "paint a tiny blue fox",
            },
          ],
        }),
      );
    },
    async ({ baseURL }) => {
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        scriptPath,
        "generate",
        "--prompt",
        "paint a tiny blue fox",
        "--api-key",
        "test-key",
        "--base-url",
        `${baseURL}/v1`,
        "--output",
        outputPath,
      ]);

      assert.equal(stderr, "");
      const result = JSON.parse(stdout);
      assert.equal(result.ok, true);
      assert.equal(result.command, "generate");
      assert.equal(result.size, DEFAULT_GENERATE_SIZE);
      assert.equal("request" in result, false);
      assert.equal(result.saved.length, 1);
      assert.equal(result.saved[0].absolute_path, outputPath);
      assert.match(result.saved[0].markdown, /^!\[generate-1\]\(\/[A-Z]:\//i);
      const savedBytes = await readFile(outputPath);
      assert.equal(savedBytes.toString("base64"), fixturePngBase64);
    },
  );
});

test("edit command uses multipart uploads for multiple images and mask", async () => {
  const tempDir = await createTempDir();
  const imageOne = path.join(tempDir, "inputs", "image-1.png");
  const imageTwo = path.join(tempDir, "inputs", "image-2.png");
  const maskPath = path.join(tempDir, "inputs", "mask.png");
  const outputPath = path.join(tempDir, "edited.webp");

  await writePng(imageOne);
  await writePng(imageTwo);
  await writePng(maskPath);

  await withMockServer(
    async (req, res, body) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/images/edits");
      assert.match(req.headers["authorization"], /^Bearer edit-key$/);
      assert.match(req.headers["content-type"], /^multipart\/form-data;/);

      const parts = parseMultipart(body, req.headers["content-type"]);
      const imageParts = parts.filter((part) => part.name === "image[]" || part.name === "image");
      assert.equal(imageParts.length, 2);
      assert.deepEqual(
        imageParts.map((part) => part.filename),
        ["image-1.png", "image-2.png"],
      );
      const maskParts = parts.filter((part) => part.name === "mask");
      assert.equal(maskParts.length, 1);
      assert.equal(maskParts[0].filename, "mask.png");
      assert.equal(
        parts.find((part) => part.name === "model")?.body,
        "gpt-image-1",
      );
      assert.equal(
        parts.find((part) => part.name === "prompt")?.body,
        "replace the center with a glowing lantern",
      );
      assert.equal(parts.find((part) => part.name === "output_format")?.body, "webp");
      assert.equal(parts.find((part) => part.name === "quality")?.body, "low");
      assert.equal(parts.find((part) => part.name === "size")?.body, "1024x1024");

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              b64_json: fixturePngBase64,
            },
          ],
        }),
      );
    },
    async ({ baseURL }) => {
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        scriptPath,
        "edit",
        "--image",
        imageOne,
        "--image",
        imageTwo,
        "--mask",
        maskPath,
        "--prompt",
        "replace the center with a glowing lantern",
        "--api-key",
        "edit-key",
        "--base-url",
        `${baseURL}/v1`,
        "--model",
        "gpt-image-1",
        "--output",
        outputPath,
        "--output-format",
        "webp",
        "--quality",
        "low",
        "--size",
        "1024x1024",
        "--verbose-response",
      ]);

      assert.equal(stderr, "");
      const result = JSON.parse(stdout);
      assert.equal(result.ok, true);
      assert.equal(result.command, "edit");
      assert.equal(result.request.image_count, 2);
      assert.equal(result.saved[0].absolute_path, outputPath);
      const savedBytes = await readFile(outputPath);
      assert.equal(savedBytes.toString("base64"), fixturePngBase64);
    },
  );
});

test("config file works and CLI overrides config values", async () => {
  const tempDir = await createTempDir();
  const configPath = path.join(tempDir, "config.json");
  const outputDir = `${path.join(tempDir, "outputs")}${path.sep}`;

  await writeFile(
    configPath,
    JSON.stringify(
      {
        apiKey: "config-key",
        baseURL: "http://127.0.0.1:1/v1",
        model: "gpt-image-1",
        quality: "high",
        output: outputDir,
      },
      null,
      2,
    ),
  );

  await withMockServer(
    async (req, res, body) => {
      const parsed = JSON.parse(body.toString("utf8"));
      assert.equal(parsed.model, "gpt-image-2");
      assert.equal(parsed.quality, "medium");
      assert.match(req.headers["authorization"], /^Bearer config-key$/);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ b64_json: fixturePngBase64 }],
        }),
      );
    },
    async ({ baseURL }) => {
      const { stdout } = await execFileAsync(process.execPath, [
        scriptPath,
        "generate",
        "--config",
        configPath,
        "--prompt",
        "paint a red kite",
        "--base-url",
        `${baseURL}/v1`,
        "--model",
        "gpt-image-2",
        "--quality",
        "medium",
      ]);

      const result = JSON.parse(stdout);
      assert.equal(result.model, "gpt-image-2");
      assert.equal(result.quality, "medium");
      assert.equal(result.saved.length, 1);
      assert.match(result.saved[0].absolute_path, /image-outputs|outputs/i);
    },
  );
});

test("resolveInvocation defaults to api-direct base URL and reuses auth.json key for claudecodes.org subdomain provider matching", async () => {
  const tempDir = await createTempDir();
  const codexHome = await createCodexHome(tempDir, {
    authJson: {
      auth_mode: "api",
      openai_api_key: "auth-json-key",
    },
    configToml: buildProviderConfigToml({
      modelProvider: "claudecodes_subdomain",
      baseURL: "https://api-direct.claudecodes.org/v1/",
      experimentalBearerToken: "provider-key",
    }),
  });

  const invocation = await resolveInvocation(
    "generate",
    {
      prompt: "draw a lantern festival",
      image: [],
    },
    {
      cwd: repoRoot,
      env: {
        CODEX_HOME: codexHome,
        USERPROFILE: tempDir,
        HOME: tempDir,
        OPENAI_API_KEY: "",
      },
    },
  );

  assert.equal(invocation.apiKey, "auth-json-key");
  assert.equal(invocation.baseURL, DEFAULT_BASE_URL);
  assert.equal(invocation.size, DEFAULT_GENERATE_SIZE);
});

test("resolveInvocation reuses provider experimental token for niucodes.com subdomain provider matching", async () => {
  const tempDir = await createTempDir();
  const codexHome = await createCodexHome(tempDir, {
    authJson: {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "ignored-auth-json-key",
    },
    configToml: buildProviderConfigToml({
      modelProvider: "niucodes_subdomain",
      baseURL: "https://img.niucodes.com/v1/",
      experimentalBearerToken: "niucodes-subdomain-token",
    }),
  });

  const invocation = await resolveInvocation(
    "generate",
    {
      prompt: "draw a lantern festival",
      image: [],
    },
    {
      cwd: repoRoot,
      env: {
        CODEX_HOME: codexHome,
        USERPROFILE: tempDir,
        HOME: tempDir,
        OPENAI_API_KEY: "",
      },
    },
  );

  assert.equal(invocation.apiKey, "niucodes-subdomain-token");
  assert.equal(invocation.baseURL, DEFAULT_BASE_URL);
});

test("resolveInvocation keeps edit size on auto by default", async () => {
  const tempDir = await createTempDir();
  const codexHome = await createCodexHome(tempDir);

  const invocation = await resolveInvocation(
    "edit",
    {
      prompt: "add a red scarf",
      image: [path.join(repoRoot, "package.json")],
      apiKey: "edit-default-key",
    },
    {
      cwd: repoRoot,
      env: {
        CODEX_HOME: codexHome,
        USERPROFILE: tempDir,
        HOME: tempDir,
        OPENAI_API_KEY: "",
      },
    },
  );

  assert.equal(invocation.size, DEFAULT_EDIT_SIZE);
});

test("CLI auto-discovers auth.json API key for API login with matching provider base_url", async () => {
  const tempDir = await createTempDir();
  const codexHome = await createCodexHome(tempDir, {
    authJson: {
      auth_mode: "api",
      OPENAI_API_KEY: "api-mode-auth-key",
    },
    configToml: buildProviderConfigToml({
      modelProvider: "claudecodes_org",
      baseURL: "https://claudecodes.org/v1/",
      experimentalBearerToken: "ignored-provider-token",
    }),
  });
  const outputPath = path.join(tempDir, "api-mode-generate.png");

  await withMockServer(
    async (req, res, body) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/images/generations");
      assert.match(req.headers["authorization"], /^Bearer api-mode-auth-key$/);
      const parsed = JSON.parse(body.toString("utf8"));
      assert.equal(parsed.prompt, "paint a paper crane");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ b64_json: fixturePngBase64 }],
        }),
      );
    },
    async ({ baseURL }) => {
      const { stdout, stderr } = await runCli(
        [
          "generate",
          "--prompt",
          "paint a paper crane",
          "--output",
          outputPath,
        ],
        {
          env: {
            CODEX_HOME: codexHome,
            USERPROFILE: tempDir,
            HOME: tempDir,
            OPENAI_API_KEY: "",
            OPENAI_BASE_URL: `${baseURL}/v1`,
          },
        },
      );

      assert.equal(stderr, "");
      const result = JSON.parse(stdout);
      assert.equal(result.base_url, `${baseURL}/v1`);
      assert.equal(result.saved[0].absolute_path, outputPath);
    },
  );
});

test("CLI auto-discovers auth.json API key for API login with niucodes.com exact provider base_url", async () => {
  const tempDir = await createTempDir();
  const codexHome = await createCodexHome(tempDir, {
    authJson: {
      auth_mode: "api",
      OPENAI_API_KEY: "api-mode-niucodes-key",
    },
    configToml: buildProviderConfigToml({
      modelProvider: "niucodes_org",
      baseURL: "https://niucodes.com/v1/",
      experimentalBearerToken: "ignored-provider-token",
    }),
  });
  const outputPath = path.join(tempDir, "api-mode-niucodes.png");

  await withMockServer(
    async (req, res, body) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/images/generations");
      assert.match(req.headers["authorization"], /^Bearer api-mode-niucodes-key$/);
      const parsed = JSON.parse(body.toString("utf8"));
      assert.equal(parsed.prompt, "paint a folded boat");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ b64_json: fixturePngBase64 }],
        }),
      );
    },
    async ({ baseURL }) => {
      const { stdout, stderr } = await runCli(
        [
          "generate",
          "--prompt",
          "paint a folded boat",
          "--output",
          outputPath,
        ],
        {
          env: {
            CODEX_HOME: codexHome,
            USERPROFILE: tempDir,
            HOME: tempDir,
            OPENAI_API_KEY: "",
            OPENAI_BASE_URL: `${baseURL}/v1`,
          },
        },
      );

      assert.equal(stderr, "");
      const result = JSON.parse(stdout);
      assert.equal(result.base_url, `${baseURL}/v1`);
      assert.equal(result.saved[0].absolute_path, outputPath);
    },
  );
});

test("CLI auto-discovers selected provider experimental_bearer_token for account login with matching provider base_url", async () => {
  const tempDir = await createTempDir();
  const codexHome = await createCodexHome(tempDir, {
    authJson: {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "ignored-auth-json-key",
    },
    configToml: buildProviderConfigToml({
      modelProvider: "niucodes_org",
      baseURL: "https://niucodes.com/v1",
      experimentalBearerToken: "provider-fallback-key",
    }),
  });
  const outputPath = path.join(tempDir, "provider-fallback.png");

  await withMockServer(
    async (req, res, body) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/images/generations");
      assert.match(req.headers["authorization"], /^Bearer provider-fallback-key$/);
      const parsed = JSON.parse(body.toString("utf8"));
      assert.equal(parsed.prompt, "paint a paper lantern");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ b64_json: fixturePngBase64 }],
        }),
      );
    },
    async ({ baseURL }) => {
      const { stdout, stderr } = await runCli(
        [
          "generate",
          "--prompt",
          "paint a paper lantern",
          "--output",
          outputPath,
        ],
        {
          env: {
            CODEX_HOME: codexHome,
            USERPROFILE: tempDir,
            HOME: tempDir,
            OPENAI_API_KEY: "",
            OPENAI_BASE_URL: `${baseURL}/v1`,
          },
        },
      );

      assert.equal(stderr, "");
      const result = JSON.parse(stdout);
      assert.equal(result.base_url, `${baseURL}/v1`);
      assert.equal(result.saved[0].absolute_path, outputPath);
    },
  );
});

test("CLI auto-discovers selected provider experimental_bearer_token for account login with claudecodes.org subdomain provider base_url", async () => {
  const tempDir = await createTempDir();
  const codexHome = await createCodexHome(tempDir, {
    authJson: {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "ignored-auth-json-key",
    },
    configToml: buildProviderConfigToml({
      modelProvider: "claudecodes_subdomain",
      baseURL: "https://api-direct.claudecodes.org/v1",
      experimentalBearerToken: "claudecodes-subdomain-token",
    }),
  });
  const outputPath = path.join(tempDir, "claudecodes-subdomain.png");

  await withMockServer(
    async (req, res, body) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/images/generations");
      assert.match(req.headers["authorization"], /^Bearer claudecodes-subdomain-token$/);
      const parsed = JSON.parse(body.toString("utf8"));
      assert.equal(parsed.prompt, "paint a folded crane");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ b64_json: fixturePngBase64 }],
        }),
      );
    },
    async ({ baseURL }) => {
      const { stdout, stderr } = await runCli(
        [
          "generate",
          "--prompt",
          "paint a folded crane",
          "--output",
          outputPath,
        ],
        {
          env: {
            CODEX_HOME: codexHome,
            USERPROFILE: tempDir,
            HOME: tempDir,
            OPENAI_API_KEY: "",
            OPENAI_BASE_URL: `${baseURL}/v1`,
          },
        },
      );

      assert.equal(stderr, "");
      const result = JSON.parse(stdout);
      assert.equal(result.base_url, `${baseURL}/v1`);
      assert.equal(result.saved[0].absolute_path, outputPath);
    },
  );
});

test("CLI asks for a key when API login provider does not match and no stored key exists", async () => {
  const tempDir = await createTempDir();
  const codexHome = await createCodexHome(tempDir, {
    authJson: {
      auth_mode: "api",
      OPENAI_API_KEY: "ignored-auth-json-key",
    },
    configToml: buildProviderConfigToml({
      modelProvider: "other_provider",
      baseURL: "https://example.com/v1",
      experimentalBearerToken: "ignored-provider-token",
    }),
  });
  const skillDir = await createTempSkillDir();

  const error = await captureCliFailure(
    [
      "generate",
      "--prompt",
      "paint a cedar forest",
    ],
    {
      env: {
        CODEX_HOME: codexHome,
        USERPROFILE: tempDir,
        HOME: tempDir,
        OPENAI_API_KEY: "",
        NIUCODES_IMAGE_GEN_SKILL_DIR: skillDir,
      },
    },
  );

  assert.match(error.stderr ?? error.message, /Missing API key/);
  assert.match(error.stderr ?? error.message, /set-skill-api-key\.mjs/);
});

test("CLI asks for a key when account login provider does not match and no stored key exists", async () => {
  const tempDir = await createTempDir();
  const codexHome = await createCodexHome(tempDir, {
    authJson: {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "ignored-auth-json-key",
    },
    configToml: buildProviderConfigToml({
      modelProvider: "other_provider",
      baseURL: "https://example.com/v1",
      experimentalBearerToken: "ignored-provider-token",
    }),
  });
  const skillDir = await createTempSkillDir();

  const error = await captureCliFailure(
    [
      "generate",
      "--prompt",
      "paint a cedar forest",
    ],
    {
      env: {
        CODEX_HOME: codexHome,
        USERPROFILE: tempDir,
        HOME: tempDir,
        OPENAI_API_KEY: "",
        NIUCODES_IMAGE_GEN_SKILL_DIR: skillDir,
      },
    },
  );

  assert.match(error.stderr ?? error.message, /Missing API key/);
  assert.match(error.stderr ?? error.message, /set-skill-api-key\.mjs/);
});

test("set-skill-api-key script writes the first body line and extractor reads it back", async () => {
  const skillDir = await createTempSkillDir();

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    setterScriptPath,
    "--skill-dir",
    skillDir,
    "--api-key",
    "stored-test-key",
  ]);

  assert.equal(stderr, "");
  assert.match(stdout, /Stored API key in .*SKILL\.md/);

  const updatedSkillContent = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  assert.match(
    updatedSkillContent,
    /^---\r?\n[\s\S]*?\r?\n---\r?\nAPI_KEY: stored-test-key\r?\n/m,
  );
  assert.equal(extractStoredSkillApiKey(updatedSkillContent), "stored-test-key");
});

test("CLI falls back to stored SKILL.md API key for unsupported API-login scenarios", async () => {
  const tempDir = await createTempDir();
  const codexHome = await createCodexHome(tempDir, {
    authJson: {
      auth_mode: "api",
      OPENAI_API_KEY: "ignored-auth-json-key",
    },
    configToml: buildProviderConfigToml({
      modelProvider: "other_provider",
      baseURL: "https://example.com/v1",
      experimentalBearerToken: "ignored-provider-token",
    }),
  });
  const skillDir = await createTempSkillDir();
  const outputPath = path.join(tempDir, "stored-api-login.png");

  await execFileAsync(process.execPath, [
    setterScriptPath,
    "--skill-dir",
    skillDir,
    "--api-key",
    "stored-skill-key-api",
  ]);

  await withMockServer(
    async (req, res, body) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/images/generations");
      assert.match(req.headers["authorization"], /^Bearer stored-skill-key-api$/);
      const parsed = JSON.parse(body.toString("utf8"));
      assert.equal(parsed.prompt, "paint a green badge");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ b64_json: fixturePngBase64 }],
        }),
      );
    },
    async ({ baseURL }) => {
      const { stdout, stderr } = await runCli(
        [
          "generate",
          "--prompt",
          "paint a green badge",
          "--output",
          outputPath,
        ],
        {
          env: {
            CODEX_HOME: codexHome,
            USERPROFILE: tempDir,
            HOME: tempDir,
            OPENAI_API_KEY: "",
            OPENAI_BASE_URL: `${baseURL}/v1`,
            NIUCODES_IMAGE_GEN_SKILL_DIR: skillDir,
          },
        },
      );

      assert.equal(stderr, "");
      const result = JSON.parse(stdout);
      assert.equal(result.saved[0].absolute_path, outputPath);
    },
  );
});

test("CLI falls back to stored SKILL.md API key for unsupported account-login scenarios", async () => {
  const tempDir = await createTempDir();
  const codexHome = await createCodexHome(tempDir, {
    authJson: {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "ignored-auth-json-key",
    },
    configToml: buildProviderConfigToml({
      modelProvider: "other_provider",
      baseURL: "https://example.com/v1",
      experimentalBearerToken: "ignored-provider-token",
    }),
  });
  const skillDir = await createTempSkillDir();
  const outputPath = path.join(tempDir, "stored-account-login.png");

  await execFileAsync(process.execPath, [
    setterScriptPath,
    "--skill-dir",
    skillDir,
    "--api-key",
    "stored-skill-key-account",
  ]);

  await withMockServer(
    async (req, res, body) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/images/generations");
      assert.match(req.headers["authorization"], /^Bearer stored-skill-key-account$/);
      const parsed = JSON.parse(body.toString("utf8"));
      assert.equal(parsed.prompt, "paint a silver badge");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ b64_json: fixturePngBase64 }],
        }),
      );
    },
    async ({ baseURL }) => {
      const { stdout, stderr } = await runCli(
        [
          "generate",
          "--prompt",
          "paint a silver badge",
          "--output",
          outputPath,
        ],
        {
          env: {
            CODEX_HOME: codexHome,
            USERPROFILE: tempDir,
            HOME: tempDir,
            OPENAI_API_KEY: "",
            OPENAI_BASE_URL: `${baseURL}/v1`,
            NIUCODES_IMAGE_GEN_SKILL_DIR: skillDir,
          },
        },
      );

      assert.equal(stderr, "");
      const result = JSON.parse(stdout);
      assert.equal(result.saved[0].absolute_path, outputPath);
    },
  );
});

test("gpt-image-2 rejects unsupported input-fidelity before any network call", async () => {
  await assert.rejects(
    () =>
      runCli([
        "edit",
        "--image",
        path.join(repoRoot, "package.json"),
        "--prompt",
        "turn this into an illustration",
        "--api-key",
        "test-key",
        "--input-fidelity",
        "high",
      ]),
    /gpt-image-2 requires omitting inputFidelity/,
  );
});
