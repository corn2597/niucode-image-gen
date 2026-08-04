# NiuCodes Image Gen v1.8.0

This release reduces image generation and editing to one native process, one
HTTPS request, one total deadline, and one command-specific successful terminal
event.

## Fixed

- Fix valid long-running requests being killed by the former 300-second
  waiting-headers or 120-second waiting-completed deadlines.
- Remove all phase and cleanup deadline branches. `timeoutMs` is now the only
  user-configurable HTTP request deadline and remains 600 seconds by default.
- Return as soon as a complete matching `image_generation.completed` or
  `image_edit.completed` JSON payload is received, even when the SSE frame has
  no trailing delimiter and the upstream connection remains open.
- Cancel the response reader and destroy the one-shot HTTP dispatcher
  immediately after the completed image instead of waiting for `[DONE]`,
  `response.completed`, EOF, or proxy connection closure.
- Keep matching partial-image events optional and repeatable. They never save an
  image, terminate the request, reset a timer, or trigger another request.
- Parse SSE chunk boundaries, CRLF, comments, and transport metadata without
  treating them as additional image lifecycle events.
- Report `http_ms`, `save_ms`, `total_ms`, and `wrapper_overhead_ms` so wrapper
  latency is directly visible.
- Preserve strict Base64 and PNG/JPEG/WebP validation plus atomic output writes.

## Fixed protocol

- Base URL: `https://api-direct.claudecodes.org/v1`
- Generation: `POST /images/generations`
- Editing: `POST /images/edits`
- `stream: true`, `partial_images: 0`, `n: 1`
- No preflight, automatic retry, second native process, or second API request

## Installer and permissions

- Keep the Apple Silicon and Intel GUI DMG installers on the latest formal
  Gitee Release source with API-key entry and SHA-256 verification.
- Preserve the API key during upgrades while deleting obsolete phase-deadline
  and configurable-base-URL fields.
- Install the executable as 0755, config as 0600, and verify the default output
  directory is writable.
- Do not modify Codex `sandbox_mode`, `approval_policy`, `network_access`, or
  `writable_roots`. The Skill uses one scoped command approval in approval modes
  and launches normally in full-access mode.
- Keep all Windows runtime and installer content out of this repository and its
  Release assets.

## Verification

- Deterministic lifecycle, timeout, installer-migration, output, and one-request
  tests
- Packaged generation and multipart editing E2E for macOS Apple Silicon and
  Intel
- Five live generation requests and five live edit requests from ten new Codex
  conversations, with no retry; all ten returned the matching completed event,
  saved a valid PNG, and exited successfully
