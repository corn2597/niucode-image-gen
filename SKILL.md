---
name: niucodes-image-gen
description: Thin API-forwarding wrapper for OpenAI-compatible image generation and editing through the bundled Node CLI. Use when Codex should spend minimal effort on reasoning, prompt rewriting, or workflow discussion and should instead pass the user's prompt and local image inputs directly to `/v1/images/generations` or `/v1/images/edits`, then return renderable local image outputs.
---
API_KEY: <ask-user-for-a-valid-api-key-in-chat-and-store-it-here-when-auto-discovery-does-not-apply>
# niucodes image gen

Treat this skill as a thin transport tool.

## Rules

- Forward the user's prompt verbatim unless they explicitly ask for prompt rewriting.
- Prefer one direct script call over analysis, ideation, or multi-step planning.
- Ask only for missing required inputs:
  - `generate`: prompt
  - `edit`: prompt plus at least one local `--image`
- If no API key is available from the supported auto-discovery cases and the first-body-line `API_KEY:` value is still the placeholder or missing, ask the user in chat for a valid API key, then immediately persist it by running `node "$SkillDir/scripts/set-skill-api-key.mjs" --api-key "<key>"`. Do not ask the user to edit files, env vars, auth.json, or config.toml manually.
- Keep the response short after the script finishes. Reuse `saved[*].markdown` so the local images render inline.
- Use `--verbose-response` only for debugging.

## Defaults

- `baseURL`: `https://api-direct.claudecodes.org/v1`
- `apiKey` resolution order:
  - `--api-key`
  - `OPENAI_API_KEY`
  - config file `apiKey`
  - Codex API login + current provider `base_url = https://api-direct.claudecodes.org/v1` -> reuse `~/.codex/auth.json` `openai_api_key` or `OPENAI_API_KEY`
  - Codex account login + selected `model_provider` `base_url = https://api-direct.claudecodes.org/v1` -> reuse that provider `experimental_bearer_token`
  - stored first-body-line `API_KEY:` value in this `SKILL.md`
- `generate size`: `1024x1024`
- `edit size`: `auto`

## Commands

Generate:

```powershell
$SkillDir = "<path-to-niucodes-image-gen>"
node "$SkillDir/scripts/niucodes-image-gen.mjs" generate `
  --prompt "A brass robot reading in a rainy library" `
  --output "./image-outputs/"
```

Edit:

```powershell
$SkillDir = "<path-to-niucodes-image-gen>"
node "$SkillDir/scripts/niucodes-image-gen.mjs" edit `
  --image "./inputs/source.png" `
  --prompt "Turn this into a clean studio product photo" `
  --output "./image-outputs/edited.png"
```

## Speed Bias

- If the user cares about speed more than fidelity, prefer the smallest default generate size and set `--quality low`.
- Do not add extra explanation, provider comparisons, or prompt-enhancement steps unless asked.
