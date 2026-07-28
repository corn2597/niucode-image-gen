---
name: niucodes-image-gen
description: Direct native OpenAI Images generation and editing through one streaming request. Use only when `$niucodes-image-gen` is named or the user explicitly requests this configured local Images API.
---

# niucodes image gen

This skill is a direct Images API wrapper. Run exactly one bundled native executable for each user request. Its embedded HTTP client sends an SSE image stream with `partial_images: 0`, saves as soon as a complete final JSON/Base64 payload arrives (even if a proxy omits the SSE blank-line delimiter), and then closes the response without waiting for EOF. Do not use an MCP tool, PowerShell runner, extra LLM prompt processing, API preflight, retry, image read, or a second image request.

The installed skill root is `${CODEX_HOME:-$HOME/.codex}/skills/niucodes-image-gen` on macOS and `$env:USERPROFILE\.codex\skills\niucodes-image-gen` on Windows. Its executable is in that root's `bin` directory. On Apple Silicon use `niucodes-image-gen-macos-arm64`; on Intel macOS use `niucodes-image-gen-macos-x64`; on Windows use `niucodes-image-gen-win-x64.exe`.

Unless the user explicitly specifies an output location, save images and status files under `$HOME/Pictures/niucodes-image-gen` on macOS or `$env:USERPROFILE\Pictures\niucodes-image-gen` on Windows. Create that directory when needed. Never default to the current workspace, a repository, the skill directory, or a temporary directory: the final `saved[*].markdown` path must remain available for the user to render after the task ends.

Build one UTF-8 JSON object with absolute paths. Preserve the user prompt verbatim. Include `image` only for `edit`; set `quality` to `low` unless the user requested another quality. `statusFile` is required and is only a final-result recovery file.

```json
{"version":1,"command":"generate","statusFile":"/absolute/user-output/generate.status.json","prompt":"original user prompt","output":"/absolute/user-output/image.png","quality":"low","size":"1024x1024","overwrite":true}
```

For edit, set `command` to `edit` and add `image` as an array of absolute source-image paths; optionally add an absolute `mask`. Do not include `apiKey`, `config`, `baseUrl`, `stream`, or `partialImages` in the JSON.

Use `run --request-stdin` as the normal entrypoint. Pass the JSON as UTF-8 stdin to the native executable in the same terminal call. Never first create a request file, a temporary shell script, or a PowerShell script. Do not pass prompt, output, image, mask, quality, size, or overwrite as command-line arguments. `run --request-file` exists only for old automation compatibility and is not the normal skill workflow.

For macOS, use one terminal command with a quoted here-document. Substitute the host-appropriate executable (`macos-arm64` or `macos-x64`) and the JSON object; do not add setup commands before it.

```sh
"$HOME/.codex/skills/niucodes-image-gen/bin/niucodes-image-gen-macos-arm64" run --request-stdin <<'NIUCODES_REQUEST'
{"version":1,"command":"generate","statusFile":"/absolute/user-output/generate.status.json","prompt":"original user prompt","output":"/absolute/user-output/image.png","quality":"low","size":"1024x1024","overwrite":true}
NIUCODES_REQUEST
```

For Windows, use one PowerShell terminal command. Keep the JSON inside the quoted here-string and invoke the `.exe` with `&`; this preserves Chinese text and spaces without PowerShell parameter binding.

```powershell
$utf8 = [System.Text.UTF8Encoding]::new($false)
$previousOutputEncoding = $OutputEncoding
$exitCode = 1
try {
  $OutputEncoding = $utf8
  $request = @'
{"version":1,"command":"generate","statusFile":"C:\\absolute\\user-output\\generate.status.json","prompt":"original user prompt","output":"C:\\absolute\\user-output\\image.png","quality":"low","size":"1024x1024","overwrite":true}
'@
  $request | & (Join-Path $env:USERPROFILE ".codex\\skills\\niucodes-image-gen\\bin\\niucodes-image-gen-win-x64.exe") run --request-stdin
  $exitCode = $LASTEXITCODE
} finally {
  $OutputEncoding = $previousOutputEncoding
}
exit $exitCode
```

The native process writes a `running` status then an atomic final status JSON, and writes that final UTF-8 JSON object as its only stdout. Wait for the same terminal session to exit. Do not launch a second process, poll the status file, interrupt a running process, or call any other tool while it runs. If and only if the exited terminal stdout is empty or invalid JSON, read that request's `statusFile` exactly once. Accept the fallback only when `status` is `success` or `failed`; otherwise report an unconfirmed final result and never run it again. The final response must use the returned `saved[*].markdown` path directly; do not inspect, copy, encode, or re-save the image before answering.

When Codex runs the terminal through `tools.exec_command`, its initial result can contain `session_id` instead of final stdout. Keep that *same* terminal alive until it exits. Use one empty `tools.write_stdin` wait of up to 300000 milliseconds; this prevents a normal 1-3 minute image request from returning to the model every 30 seconds. Only issue another empty wait when that 300-second wait itself returns a `session_id`. Copy the following orchestration verbatim: the variable must be `let result`, never `const`, because it is reassigned by the loop. Do not set `sandbox_permissions`, `justification`, or `prefix_rule`; they can turn an already-authorized local image request into an approval prompt. Never use an outer `wait` call as a substitute, and never launch another terminal command while the session exists.

```js
const executable = "/Users/example/.codex/skills/niucodes-image-gen/bin/niucodes-image-gen-macos-arm64"; // Replace once with this host's absolute binary path.
const requestJson = JSON.stringify({
  version: 1,
  command: "generate",
  statusFile: "/absolute/user-output/generate.status.json",
  prompt: "original user prompt",
  output: "/absolute/user-output/image.png",
  quality: "low",
  size: "1024x1024",
  overwrite: true,
});
const cmd = `"${executable}" run --request-stdin <<'NIUCODES_REQUEST'\n${requestJson}\nNIUCODES_REQUEST`;
let result = await tools.exec_command({
  cmd,
  workdir,
  yield_time_ms: 30000,
});
while (result.session_id) {
  result = await tools.write_stdin({ session_id: result.session_id, chars: "", yield_time_ms: 300000 });
}
text(result.output);
```

`config.json.timeoutMs` is an end-to-end request deadline with a maximum of 600000 milliseconds. On timeout, `SIGINT`, `SIGTERM`, broken stream, missing completed event, or stream error, the native process closes the underlying HTTP request and emits one final failed JSON result. It never falls back to non-streaming and never retries, because delivery might already be billable.

On success, the final answer must contain all of these values copied from the final native JSON: `status`, `exit_code`, `timing_ms`, and `error`. Then put every returned `saved[*].markdown` string on its own line **verbatim**. Do not replace it with a basename, label, or prose such as `generate-1`; the literal `![...](absolute-path)` is required so the image renders in the chat. Use this exact shape:

```text
status: success
exit_code: 0
timing_ms: {"total":123}
error: null
![generate-1](/absolute/output.png)
```

On failure, answer with `status`, `exit_code`, `timing_ms`, and `error.message`. Do not make another tool call after the final result.

Every request has a `client_request_id`. If `stage` or `error.kind` is `request_delivery_unknown`, the image service may have received the request even though the client did not receive a complete stream. Do not retry or claim the API rejected it; include `client_request_id` in the final answer for operator tracing.

`config.json` at the package root is the only API credential source. Never request, inspect, print, store, or pass its API key through chat, environment variables, flags, or documentation. A corporate outbound `proxyUrl` may be set only in that config file and must never be printed.
