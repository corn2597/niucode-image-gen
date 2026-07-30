---
name: niucodes-image-gen
description: Self-contained native OpenAI Images generation and editing through one configured streaming request. Use only when `$niucodes-image-gen` is named or the user explicitly requests this configured local Images API. Normal image requests require no memory, repository, config, or source-image inspection.
---

# niucodes image gen

Run exactly one bundled native executable for each request. Do not use MCP, PowerShell runners, temporary scripts, request files, API preflight, retry, prompt rewriting, image inspection, or a second request.

## Execution gate

Open the installed `SKILL.md` exactly once as required by Codex. Do not inspect memory, config, the source image, the output directory, or repository files before a normal request. Do not run architecture or credential checks. Build the request from the user message and make the **next tool call one `functions.exec` call** that launches `run --request-stdin`, waits for the nested terminal session, and returns final native stdout. Do not split launch and terminal waiting across model turns.

Use the installed executable from `${CODEX_HOME:-$HOME/.codex}/skills/niucodes-image-gen/bin` on macOS or `$env:USERPROFILE\.codex\skills\niucodes-image-gen\bin` on Windows. Select `niucodes-image-gen-macos-arm64` on Apple Silicon, `niucodes-image-gen-macos-x64` on Intel macOS, or `niucodes-image-gen-win-x64.exe` on Windows.

Build one UTF-8 JSON line with `version: 2`, preserve the user prompt verbatim, and send it to `run --request-stdin`. The line is a single request frame and does not require stdin EOF. When the current task has a workspace, set `workspace` to that task's actual absolute root; never send a sample or placeholder path. Do not include `apiKey`, `config`, `baseUrl`, `stream`, `partialImages`, or `statusFile` in a normal request.

```json
{"version":2,"command":"generate","prompt":"original user prompt","quality":"low","size":"1024x1024"}
```

For `edit`, add `images` as an array of absolute input-image paths and optionally an absolute `mask`. Multiple input images are supported; the request still produces exactly one output image. Do not set `n` other than `1`.

Output location priority is: explicit absolute `output`; `workspace/image-outputs/niucodes-image-gen`; current task working directory `image-outputs/niucodes-image-gen` when it is not a system temporary directory; configured default output; `~/Pictures/niucodes-image-gen` on macOS or `%USERPROFILE%\\Pictures\\niucodes-image-gen` on Windows; then persistent per-user application data (`~/Library/Application Support/niucodes-image-gen/outputs` on macOS or `%LOCALAPPDATA%\\niucodes-image-gen\\outputs` on Windows). Do not create a system temporary output directory or write images inside the skill directory. The native runner validates output writability before the API request. On failure, return its JSON error and do not retry. The configured request timeout is 10 minutes; do not interrupt a request before that deadline.

Invoke the native executable through `tools.exec_command` inside one `functions.exec` JavaScript program. If the nested terminal returns `session_id`, wait on that exact terminal with `tools.write_stdin` inside the same program. This inner loop is mandatory: `functions.wait` waits only for the outer JavaScript cell and cannot replace `tools.write_stdin` for the native terminal session.

On macOS, use this program shape verbatim. Set `executable` to the absolute installed Apple Silicon or Intel binary path, `requestJson` to the one-line v2 frame, and `workdir` to the real task working directory:

```js
// @exec: {"yield_time_ms": 30000, "max_output_tokens": 20000}
const cmd = `"${executable}" run --request-stdin <<'NIUCODES_REQUEST'\n${requestJson}\nNIUCODES_REQUEST`;
let result = await tools.exec_command({
  cmd,
  workdir,
  yield_time_ms: 30000,
});
while (result.session_id) {
  result = await tools.write_stdin({
    session_id: result.session_id,
    chars: "",
    yield_time_ms: 300000,
    max_output_tokens: 20000,
  });
}
text(result.output);
```

On Windows, use this program shape verbatim. Set `executable`, `requestJson`, and `workdir` to their real absolute values. It starts only the installed native executable, sends exactly one UTF-8 JSON line, and does not use a PowerShell here-string, pipeline, or request parameters:

```js
// @exec: {"yield_time_ms": 30000, "max_output_tokens": 20000}
const command = `& "${executable}" run --request-stdin`;
let result = await tools.exec_command({
  cmd: command,
  workdir,
  tty: true,
  yield_time_ms: 1000,
});
if (result.session_id) {
  result = await tools.write_stdin({
    session_id: result.session_id,
    chars: `${requestJson}\n`,
    yield_time_ms: 30000,
    max_output_tokens: 20000,
  });
}
while (result.session_id) {
  result = await tools.write_stdin({
    session_id: result.session_id,
    chars: "",
    yield_time_ms: 300000,
    max_output_tokens: 20000,
  });
}
text(result.output);
```

Never start a second native process or poll a result/status file.

The outer `functions.exec` may itself return `Script running with cell ID <id>` while its JavaScript program continues waiting on the nested terminal. In that case, call `functions.wait` for that outer `cell_id` until it completes. The completed outer cell must contain the final native JSON. Do not confuse the outer `cell_id` with the nested terminal `session_id`, and never answer while either remains active. The executable emits one UTF-8 JSON object on stdout and writes operational logs only to stderr.

The runner saves immediately after a valid `image_generation.completed` or `image_edit.completed` Base64 payload. It does not wait for an SSE delimiter, `[DONE]`, EOF, or proxy connection closure. `config.json` is the only credential source. Never print, inspect, pass, or alter its API key.

After the terminal command exits, parse its single stdout JSON line before answering. Copy `status`, `exit_code`, `timing_ms`, `phase`, `error`, and `api_request_id` from that native JSON into the final response. A request timeout is returned as `status: "timeout"`, `exit_code: 124`, and `retry_safe: false`; do not retry it automatically. Put every returned `saved[*].markdown` string on its own line **verbatim** so the image renders. Do not re-read, copy, encode, or re-save the image.
