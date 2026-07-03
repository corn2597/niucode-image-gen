---
name: niucodes-image-gen
description: Thin API-forwarding wrapper for OpenAI-compatible image generation and editing through the bundled Node CLI. Use when Codex should spend minimal effort on reasoning, prompt rewriting, or workflow discussion and should instead pass the user's prompt and local image inputs directly to `/v1/images/generations` or `/v1/images/edits`, then return renderable local image outputs.
---

# niucodes image gen

Treat this skill as a thin transport tool.

## Rules

- Forward the user's prompt verbatim unless they explicitly ask for prompt rewriting.
- Prefer one direct script call over analysis, ideation, or multi-step planning.
- Ask only for missing required inputs:
  - `generate`: prompt
  - `edit`: prompt plus at least one local `--image`
- Keep the response short after the script finishes. Reuse `saved[*].markdown` so the local images render inline.
- Use `--verbose-response` only for debugging.

## Defaults

- `baseURL`: `https://claudecodes.org/v1`
- `apiKey`: `--api-key` -> `OPENAI_API_KEY` -> `~/.codex/auth.json` -> active model provider `experimental_bearer_token`
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
