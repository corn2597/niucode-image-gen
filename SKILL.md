---
name: niucodes-image-gen
description: Direct native OpenAI Images generation and editing through a structured request file. Use only when `$niucodes-image-gen` is named or the user explicitly requests this configured local Images API.
---

# niucodes image gen

Run exactly one bundled native executable, never an MCP tool or a PowerShell runner. Create one UTF-8 JSON request file at a user-owned absolute path, then invoke the platform executable with only `run --request-file <absolute-request.json>`.

Use this request schema. Every file path is absolute. Keep the original prompt verbatim. Include `image` only for `edit`; use `--quality low` equivalent as `"quality":"low"` unless requested otherwise.

```json
{"version":1,"command":"generate","statusFile":"/absolute/user-directory/generate.status.json","prompt":"original user prompt","output":"/absolute/user-directory/image.png","quality":"low","size":"1024x1024","overwrite":true}
```

For edit, set `"command":"edit"` and add `"image":["/absolute/source.png"]`; optionally add `"mask":"/absolute/mask.png"`. Do not put `apiKey`, `config`, or `baseUrl` in the request file.

On macOS, call the matching executable in `<skill-root>/bin/niucodes-image-gen-macos-arm64` or `niucodes-image-gen-macos-x64`. On Windows, invoke `<skill-root>\\bin\\niucodes-image-gen-win-x64.exe` directly. A PowerShell `&` invocation is allowed only to start that native exe; never call a `.ps1` runner and never pass prompt, output, image, or overwrite as command-line arguments.

The native executable writes a running then final status JSON atomically, and prints that same final UTF-8 JSON result on stdout. Do not poll from Codex, retry, preflight, inspect image bytes, or make another model/API call.

Treat `config.json.timeoutMs` as an API deadline, never an early-cancel target. While the status is `running`, do not interrupt the native executable or report a timeout before the configured 600-second bound; wait for its final status instead.

Parse the one final JSON result. On success, answer with its `exit_code`, `timing_ms`, and each `saved[*].markdown` image link. On failure, answer with its `exit_code`, `timing_ms`, and `error.message`. Do not make a follow-up tool call after the runner returns.

`config.json` at the package root is the only API credential source. Never request, inspect, print, store, or pass its API key through chat, environment variables, flags, or documentation.
