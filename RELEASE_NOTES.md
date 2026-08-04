# NiuCodes Image Gen v1.8.1

This patch fixes native executable selection on Intel Macs without adding an
architecture probe, launcher process, API preflight, or retry.

## Fixed

- Install the architecture selected by the Apple Silicon or Intel GUI installer
  at one stable `bin/niucodes-image-gen` path.
- Remove architecture-specific executable names from the installed Skill so
  Codex cannot infer Apple Silicon on an Intel Mac and launch a missing file.
- Keep architecture selection deterministic inside the compiled GUI installer:
  each DMG still downloads and verifies only its matching Gitee Release ZIP.
- Preserve the v1.8.0 request lifecycle: one native process, one HTTPS request,
  one user-configurable total timeout, no automatic retry, and immediate return
  on the matching completed image event.

## Fixed protocol

- Base URL: `https://api-direct.claudecodes.org/v1`
- Generation: `POST /images/generations`
- Editing: `POST /images/edits`
- `stream: true`, `partial_images: 0`, `n: 1`

## Verification

- Unit coverage rejects architecture-specific executable names in the Skill.
- Both release packages contain only the stable executable path while retaining
  their native Apple Silicon or Intel machine architecture.
- Packaged generation and multipart editing E2E run through the stable path on
  both architectures.
