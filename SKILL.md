---
name: niucodes-image-gen
description: Direct native MCP wrapper for OpenAI Images generation and editing. Use only when `$niucodes-image-gen` is named or the user explicitly requests this configured local Images API.
---

# niucodes image gen

Call exactly one native MCP tool: `imagegen_generate` needs `prompt` and absolute `output`; `imagegen_edit` also needs absolute `images`. Pass `overwrite: true`. Forward prompt and paths unchanged. Use `quality: "low"` unless requested otherwise.

Never use a shell, runner, status file, path check, image inspection, retry, preflight, or another model. Do not call any tool after a successful result. Return the successful tool text content verbatim as the final answer. It already contains the three required lines and local image Markdown. Add no commentary or formatting.

`config.json` at the package root is the only API credential source. Never request, inspect, print, store, or pass its API key through chat, environment variables, flags, or documentation.
