---
name: niucodes-image-gen
description: Generate or edit images through the official OpenAI Node SDK using bundled cross-platform Node scripts. Use when Codex needs to call `/v1/images/generations` or `/v1/images/edits` with configurable model, base URL, and API key; when one or more local reference images or masks must be uploaded with SDK-driven multipart form data; or when saved image outputs need Markdown snippets that render inside Codex, VS Code surfaces, or similar clients.
---

# niucodes image gen

Use the bundled Node CLI instead of rebuilding OpenAI image requests from scratch. The scripts are designed for Windows and macOS and wrap the official `openai` package for both generation and edit workflows.

## Quick Start

1. Resolve the skill directory that contains this `SKILL.md`.
2. Run `npm install` once inside the skill directory after cloning it.
3. Choose `generate` for prompt-only image creation or `edit` for local image edits.
4. Pass configuration by CLI flags, environment variables, or `--config <json-file>`.
5. After the script finishes, reuse the returned `saved[*].markdown` strings in the final answer so the saved image files render in Codex or compatible VS Code surfaces.

## Configuration

Configuration precedence is: CLI flags > environment variables > `--config` JSON file > script defaults.

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
  "apiKey": "sk-...",
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-image-2",
  "quality": "medium",
  "output": "./image-outputs/"
}
```

Do not print or echo the API key after loading configuration.

## Commands

Prompt-only generation:

```powershell
$SkillDir = "<path-to-niucodes-image-gen>"
node "$SkillDir/scripts/niucodes-image-gen.mjs" generate `
  --prompt "A cinematic photo of a brass robot reading in a rainy library" `
  --api-key "$env:OPENAI_API_KEY" `
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
  --api-key "$env:OPENAI_API_KEY" `
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
  --api-key "$env:OPENAI_API_KEY" `
  --model "gpt-image-2" `
  --output "./image-outputs/edited.png"
```

## Operating Rules

- Use local file paths for `edit`. The wrapper converts them with `toFile(...)` and lets the official SDK emit multipart form data.
- Repeat `--image` for multi-image edits. Do not hand-build multipart bodies.
- If the user does not provide an output location, let the script save under `./image-outputs/`.
- The edit API requires the source image and mask to share the same format and size.
- For `gpt-image-2`, omit `input_fidelity` and never set `background=transparent`.
- Prefer `png` unless the user explicitly wants faster or smaller `jpeg` / `webp` output.
- Quote paths that contain spaces.
- After the script returns JSON, paste the `saved[*].markdown` values into the final answer to render the generated files inline.
