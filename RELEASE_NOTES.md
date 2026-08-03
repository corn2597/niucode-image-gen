# NiuCodes Image Gen v1.7.2

This release simplifies the image generation and editing lifecycle around the
terminal events actually required to deliver an image.

## Fixed

- Use one synchronous lifecycle for both commands: send one request, wait for
  the matching completed event, save the completed image, and return it.
- Treat matching `image_generation.partial_image` and
  `image_edit.partial_image` frames as optional, repeatable progress updates.
  They are never required for success and never terminate the request.
- Keep the command-specific completed event as the only successful terminal
  event. The client returns immediately after it instead of waiting for
  `[DONE]`, EOF, or the proxy connection to close.
- Keep invalid, malformed, and cross-command events as failures of the same
  request without adding an automatic retry or a second process.
- Clarify that an outer Codex tool yield is not a native request timeout: the
  caller must keep waiting on the same running cell until the native process
  returns its final JSON.

## macOS packages

- Apple Silicon GUI installer DMG and native ZIP package
- Intel GUI installer DMG and native ZIP package
- Both GUI installers retain API configuration during upgrades and download
  the latest formal Release from Gitee
- Windows runtime and installer content remain excluded from this repository

## Verification

- 28 automated lifecycle, timeout, installer-migration, and bootstrap tests
- Packaged end-to-end generation and edit checks in the macOS Apple Silicon and
  Intel release jobs
- 5 successful generation runs from 5 new Codex conversations
- 5 successful edit runs from 5 new Codex conversations
- All 10 live requests completed without retries or exit code 137; API request
  durations ranged from 52.442 seconds to 210.376 seconds
