---
name: niucodes-image-gen
description: Self-contained native OpenAI Images generation and editing through one configured streaming request. Use only when `$niucodes-image-gen` is named or the user explicitly requests this configured local Images API. Normal image requests require no memory, repository, config, or source-image inspection.
---

# niucodes image gen

Run exactly one bundled native executable for each request. Do not use MCP, shell-specific runners, temporary scripts, request/result/status files, API preflight, retry, prompt rewriting, image inspection, or a second request.

## Execution gate

Open the installed `SKILL.md` exactly once as required by Codex. Do not inspect memory, config, the source image, the output directory, or repository files before a normal request. Do not run architecture or credential checks. Use the local command-execution capability available in the current Codex host to launch the installed native executable directly. The executable owns the complete request lifecycle, reports phase progress on stderr, and enforces its configured phase and total deadlines. Start exactly one process and wait for that same process to exit before answering.

Use the installed executable from `${CODEX_HOME:-$HOME/.codex}/skills/niucodes-image-gen/bin` on macOS. Select `niucodes-image-gen-macos-arm64` on Apple Silicon or `niucodes-image-gen-macos-x64` on Intel macOS.

Preserve the user prompt verbatim. For generation, invoke `generate --prompt <text>`. For editing, invoke `edit --prompt <text>` and repeat `--image <absolute-path>` for every input image. Add `--workspace <absolute-root>` when the current task has a workspace, and add `--output <absolute-path>` only when the user specifies one. Never pass `apiKey`, `config`, `baseUrl`, `stream`, `partialImages`, or a status path.

```text
<native-executable> generate --prompt <original-user-prompt> --quality low --size 1024x1024
```

For `edit`, repeat `--image` for multiple absolute input-image paths and optionally add `--mask <absolute-path>`. Multiple input images are supported; the request still produces exactly one output image. Do not set `n` other than `1`.

Output location priority is: explicit absolute `output`; `workspace/image-outputs/niucodes-image-gen`; current task working directory `image-outputs/niucodes-image-gen` when it is not a system temporary directory; configured default output; `~/Pictures/niucodes-image-gen`; then `~/Library/Application Support/niucodes-image-gen/outputs`. Do not create a system temporary output directory or write images inside the skill directory. The native runner validates output writability before the API request. On failure, return its JSON error and do not retry. Do not impose an external timeout or interrupt a request; the executable owns its waiting-headers, waiting-completed, and 10-minute total deadlines.

Pass arguments directly to the executable. Do not create a shell wrapper and do not translate long options into shell-script parameters. Never start a second process or poll a file. The executable emits one UTF-8 JSON object on stdout and writes operational logs only to stderr.

Use only command tools that actually exist in the current Codex host. If the host exposes a direct `shell_command`-style tool instead of `functions.exec`, invoke the native executable once through that available tool and use its own wait/completion mechanism. Never call `tools.exec_command` or `tools.write_stdin` when those functions are not exposed.

When the Codex host exposes `functions.exec`, make the launch and every nested wait one JavaScript program. Preserve the complete `exec_command` result: printing only its initial `output` loses `session_id` and can turn a successful request into an empty result. Use this control flow, with `cmd` set to the platform command and `workdir` set to the task workspace:

```js
// @exec: {"yield_time_ms": 30000, "max_output_tokens": 20000}
let result = await tools.exec_command({
  cmd,
  workdir,
  yield_time_ms: 30000,
  max_output_tokens: 20000,
});
const output = [result.output ?? ""];
while (result.session_id) {
  result = await tools.write_stdin({
    session_id: result.session_id,
    chars: "",
    yield_time_ms: 300000,
    max_output_tokens: 20000,
  });
  output.push(result.output ?? "");
}
text(output.join(""));
```

If that outer `functions.exec` returns `Script running with cell ID ...`, wait for that exact outer cell with `functions.wait` until it completes. Do not confuse the outer cell ID with the nested terminal `session_id`; do not answer until both have ended and the final native JSON is available.

The runner uses one synchronous lifecycle: send one request, ignore matching `image_generation.partial_image` or `image_edit.partial_image` progress frames, wait for the matching `image_generation.completed` or `image_edit.completed`, save that completed image, and return it. Partial frames are optional and may repeat; they never terminate the request. Do not wait for `[DONE]`, EOF, or proxy connection closure after the completed image. Invalid or cross-command events fail the same request and never trigger a retry. `config.json` is the only credential source. Never print, inspect, pass, or alter its API key.

After the terminal command exits, parse its single stdout JSON line before answering. Copy `status`, `exit_code`, `timing_ms`, `phase`, `error`, `api_request_id`, and `client_request_id` from that native JSON into the final response. A request timeout is returned as `status: "timeout"`, `exit_code: 124`, and `retry_safe: false`; do not retry it automatically. Put every returned `saved[*].markdown` string on its own line **verbatim** so the image renders. Do not re-read, copy, encode, or re-save the image.
