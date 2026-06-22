---
name: niucodes-image-gen
description: Generate or edit images through the official OpenAI Node SDK using bundled cross-platform Node scripts. Use when Codex needs to call `/v1/images/generations` or `/v1/images/edits` with configurable model plus a niucodes-compatible base URL and API key; when one or more local reference images or masks must be uploaded with SDK-driven multipart form data; or when saved image outputs need Markdown snippets that render inside Codex, VS Code surfaces, or similar clients.
---

# niucodes image gen

Use the bundled Node CLI instead of rebuilding OpenAI image requests from scratch. The scripts are designed for Windows and macOS and wrap the official `openai` package for both generation and edit workflows.

## Quick Start

1. Resolve the skill directory that contains this `SKILL.md`.
2. Run `npm install` once inside the skill directory after cloning it.
3. Choose `generate` for prompt-only image creation or `edit` for local image edits.
4. Pass configuration by CLI flags, environment variables, or `--config <json-file>`. If no API key is passed, the script auto-discovers one from `~/.codex/auth.json` or from the active model provider's `experimental_bearer_token`.
5. After the script finishes, reuse the returned `saved[*].markdown` strings in the final answer so the saved image files render in Codex or compatible VS Code surfaces.

## Configuration

Configuration precedence is: CLI flags > environment variables > `--config` JSON file > local Codex auth discovery > script defaults.

Supported environment variables:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_IMAGE_MODEL`
- `OPENAI_IMAGE_SIZE`
- `OPENAI_IMAGE_QUALITY`
- `OPENAI_IMAGE_FORMAT`
- `OPENAI_IMAGE_BACKGROUND`
- `OPENAI_IMAGE_MODERATION`
- `OPENAI_IMAGE_TIMEOUT_MS`

Minimal JSON config example:

```json
{
  "baseURL": "https://niucodes.com/v1",
  "model": "gpt-image-2",
  "quality": "medium",
  "output": "./image-outputs/"
}
```

Default behavior:

- `baseURL` defaults to `https://niucodes.com/v1`
- `apiKey` falls back to `OPENAI_API_KEY`, then `~/.codex/auth.json`, then the active model provider's `experimental_bearer_token`
- `generate` defaults `size` to `1024x1024`, which is the smallest standard GPT image size currently documented by OpenAI
- `edit` keeps `size=auto` by default so reference-image edits preserve a more natural output fit unless the caller overrides it

Do not print or echo the API key after loading configuration.

## Commands

Prompt-only generation:

```powershell
$SkillDir = "<path-to-niucodes-image-gen>"
node "$SkillDir/scripts/niucodes-image-gen.mjs" generate `
  --prompt "A cinematic photo of a brass robot reading in a rainy library" `
  --model "gpt-image-2" `
  --output "./image-outputs/"
```

Multi-image edit with SDK-driven multipart upload:

```powershell
$SkillDir = "<path-to-niucodes-image-gen>"
node "$SkillDir/scripts/niucodes-image-gen.mjs" edit `
  --image "./inputs/body-lotion.png" `
  --image "./inputs/soap.png" `
  --image "./inputs/incense-kit.png" `
  --prompt "Create a photorealistic spa gift basket that includes every reference item" `
  --model "gpt-image-2" `
  --output "./image-outputs/gift-basket.png"
```

Masked edit:

```powershell
$SkillDir = "<path-to-niucodes-image-gen>"
node "$SkillDir/scripts/niucodes-image-gen.mjs" edit `
  --image "./inputs/source.png" `
  --mask "./inputs/mask.png" `
  --prompt "Only replace the masked region with a glowing flamingo float" `
  --model "gpt-image-2" `
  --output "./image-outputs/edited.png"
```

## Operating Rules

- Use local file paths for `edit`. The wrapper converts them with `toFile(...)` and lets the official SDK emit multipart form data.
- Repeat `--image` for multi-image edits. Do not hand-build multipart bodies.
- If the user does not provide an output location, let the script save under `./image-outputs/`.
- If the user does not provide `--base-url`, use `https://niucodes.com/v1`.
- If the user does not provide `--api-key`, rely on local Codex auth discovery before asking for one manually.
- If the user does not provide `--size` for prompt-only generation, use `1024x1024` by default to favor the smallest currently documented GPT image size and reduce latency.
- The edit API requires the source image and mask to share the same format and size.
- For `gpt-image-2`, omit `input_fidelity` and never set `background=transparent`.
- Prefer `png` unless the user explicitly wants faster or smaller `jpeg` / `webp` output.
- Quote paths that contain spaces.
- After the script returns JSON, paste the `saved[*].markdown` values into the final answer to render the generated files inline.
