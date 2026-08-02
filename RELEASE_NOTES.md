# NiuCodes Image Gen v1.7.1

This release hardens the macOS image generation and editing lifecycle using the
SSE frames observed from the configured Images API.

## Fixed

- Accept only the observed command-specific event sequences:
  - generate: `image_generation.partial_image` then `image_generation.completed`
  - edit: `image_edit.partial_image` then `image_edit.completed`
- Reject unknown, cross-command, duplicated, out-of-order, or mismatched SSE
  events instead of leaving the request in an ambiguous state.
- Separate the waiting-for-headers and waiting-for-completed deadlines while
  retaining the total request deadline.
- Bound HTTP error-body reads and connection cleanup so a failed or completed
  request cannot remain blocked indefinitely.
- Preserve the original failure phase during cleanup and report stream event,
  byte, and terminal-event diagnostics.
- Parse each SSE frame once, including the large base64 image payload.
- Preserve existing API configuration when installing or upgrading through the
  macOS GUI installer.

## macOS packages

- Apple Silicon GUI installer DMG and native package
- Intel GUI installer DMG and native package
- Both installers use the latest Gitee Release as their download source
- Windows runtime and installer content remain excluded from this repository

## Verification

- 28 automated lifecycle, timeout, installer-migration, and bootstrap tests
- Packaged end-to-end generation and edit tests for Apple Silicon and Intel
- 5 successful generation runs from 5 new Codex conversations
- 5 successful edit runs from 5 new Codex conversations
- All 10 live runs completed with exactly one partial event followed by the
  command-specific completed event; no `[DONE]` event was observed or assumed
