---
name: niucodes-image-gen
description: Direct local runner for OpenAI Images generation and editing. Use only when `$niucodes-image-gen` is named or the user explicitly requests this configured local Images API.
---

# niucodes image gen

Run exactly one bundled local runner, never an MCP tool. On macOS, run `<skill-root>/scripts/invoke-imagegen.sh`; on Windows, run `<skill-root>\\scripts\\invoke-imagegen.ps1` through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`. Pass `generate` or `edit`, a user-owned absolute `--status-file` / `-StatusFile`, `--timeout-seconds 600` / `-TimeoutSeconds 600`, the original prompt, and an absolute `--output`. For edit, also pass every absolute source image with `--image`. Pass `--overwrite true` and use `--quality low` unless requested otherwise.

On Windows, put runner options first: `generate|edit`, `-StatusFile`, `-TimeoutSeconds`, and optional `-ExecutablePath` for tests. Then pass lower-case double-dash image options unchanged: `--prompt`, `--output`, `--image`, `--mask`, `--quality`, `--size`, and `--overwrite`. The runner keeps every image option and its value out of PowerShell parameter binding before starting the native executable. It also accepts the equivalent common PowerShell spellings (`-Prompt`, `-Output`, `-Image`, `-Quality`, `-Size`, and `-Overwrite`).

Use the runner already in this skill. Never create or repair a temporary runner. The runner waits and polls locally, then writes one final UTF-8 JSON result to stdout and the status file. Do not poll from Codex, retry, preflight, inspect image bytes, or make another model/API call.

Treat `config.json.timeoutMs` as an API deadline, never an early-cancel target. The required runner timeout is 600 seconds, which covers every supported `timeoutMs` value. While the status is `running`, do not interrupt the local process or report a timeout before that 600-second bound; wait for its final status instead.

Parse the one final JSON result. On success, answer with its `exit_code`, `timing_ms`, and each `saved[*].markdown` image link. On failure, answer with its `exit_code`, `timing_ms`, and `error.message`. Do not make a follow-up tool call after the runner returns.

`config.json` at the package root is the only API credential source. Never request, inspect, print, store, or pass its API key through chat, environment variables, flags, or documentation.
