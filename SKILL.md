---
name: niucodes-image-gen
description: Direct native OpenAI Images generation and editing through one configured streaming request. Use only when `$niucodes-image-gen` is named or the user explicitly requests this configured local Images API.
---

# niucodes image gen

Run exactly one bundled native executable for each request. Do not use MCP, PowerShell runners, temporary scripts, request files, API preflight, retry, prompt rewriting, image inspection, or a second request.

Use the installed executable from `${CODEX_HOME:-$HOME/.codex}/skills/niucodes-image-gen/bin` on macOS or `$env:USERPROFILE\.codex\skills\niucodes-image-gen\bin` on Windows. Select `niucodes-image-gen-macos-arm64` on Apple Silicon, `niucodes-image-gen-macos-x64` on Intel macOS, or `niucodes-image-gen-win-x64.exe` on Windows.

Build one UTF-8 JSON line with `version: 2`, preserve the user prompt verbatim, and send it to `run --request-stdin`. The line is a single request frame and does not require stdin EOF. Pass an absolute `workspace` whenever the current task has one. Do not include `apiKey`, `config`, `baseUrl`, `stream`, `partialImages`, or `statusFile` in a normal request.

```json
{"version":2,"command":"generate","workspace":"/absolute/workspace","prompt":"original user prompt","quality":"low","size":"1024x1024"}
```

For `edit`, add `images` as an array of absolute input-image paths and optionally an absolute `mask`. Multiple input images are supported; the request still produces exactly one output image. Do not set `n` other than `1`.

Output location priority is: explicit absolute `output`; `workspace/image-outputs/niucodes-image-gen`; current task working directory `image-outputs/niucodes-image-gen` when it is not a system temporary directory; configured default output; then persistent per-user application data (`~/Library/Application Support/niucodes-image-gen/outputs` on macOS or `%LOCALAPPDATA%\\niucodes-image-gen\\outputs` on Windows). Do not create a system temporary output directory or write images inside the skill directory. The native runner validates output writability before the API request. On failure, return its JSON error and do not retry. The configured request timeout is 10 minutes; do not interrupt a request before that deadline.

On macOS, invoke the executable once through a quoted here-document. Use the host-appropriate executable name.

```sh
"${CODEX_HOME:-$HOME/.codex}/skills/niucodes-image-gen/bin/niucodes-image-gen-macos-arm64" run --request-stdin <<'NIUCODES_REQUEST'
{"version":2,"command":"generate","workspace":"/absolute/workspace","prompt":"original user prompt","quality":"low","size":"1024x1024"}
NIUCODES_REQUEST
```

On Windows, use one PowerShell terminal command and pipe the JSON here-string into the executable. Do not pass request fields as PowerShell parameters.

```powershell
$request = @'
{"version":2,"command":"generate","workspace":"C:\\absolute\\workspace","prompt":"original user prompt","quality":"low","size":"1024x1024"}
'@
$request | & (Join-Path $env:USERPROFILE ".codex\skills\niucodes-image-gen\bin\niucodes-image-gen-win-x64.exe") run --request-stdin
exit $LASTEXITCODE
```

Keep the same terminal process alive until it exits. When an initial terminal call returns a session id, wait on that exact session; never start a second process or poll a status file. The executable emits one UTF-8 JSON object on stdout and writes operational logs only to stderr.

The runner saves immediately after a valid `image_generation.completed` or `image_edit.completed` Base64 payload. It does not wait for an SSE delimiter, `[DONE]`, EOF, or proxy connection closure. `config.json` is the only credential source. Never print, inspect, pass, or alter its API key.

Copy `status`, `exit_code`, `timing_ms`, `phase`, `error`, and `api_request_id` from the native JSON into the final response. A request timeout is returned as `status: "timeout"`, `exit_code: 124`, and `retry_safe: false`; do not retry it automatically. Put every returned `saved[*].markdown` string on its own line **verbatim** so the image renders. Do not re-read, copy, encode, or re-save the image.
