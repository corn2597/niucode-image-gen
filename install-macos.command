#!/bin/bash
# Install the newest signed release package from Gitee into Codex.
set -euo pipefail

REPOSITORY="niucodes/niucode-image-gen"
RELEASE_API_URL="${NIUCODES_IMAGE_GEN_RELEASE_API_URL:-https://gitee.com/api/v5/repos/${REPOSITORY}/releases/latest}"
SKILL_NAME="niucodes-image-gen"
CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
SKILL_DIR="$CODEX_ROOT/skills/$SKILL_NAME"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/niucodes-image-gen.XXXXXX")"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

fail() {
  printf 'Installation failed: %s\n' "$1" >&2
  exit 1
}

case "$(uname -m)" in
  arm64) PLATFORM="macos-arm64"; BINARY_NAME="niucodes-image-gen-macos-arm64" ;;
  x86_64) PLATFORM="macos-x64"; BINARY_NAME="niucodes-image-gen-macos-x64" ;;
  *) fail "Unsupported macOS architecture: $(uname -m)." ;;
esac

read -r -s -p "请输入 niucodes的api key，api key查找地址： workspace.claudecodes.org， 点击左侧API密钥复制：" API_KEY
printf '\n'
[[ -n "$API_KEY" ]] || fail "An API key is required."

METADATA_FILE="$TEMP_DIR/release.json"
curl --fail --location --silent --show-error "$RELEASE_API_URL" -o "$METADATA_FILE" \
  || fail "Could not fetch the latest Gitee release."

TAG="$(plutil -extract tag_name raw -o - "$METADATA_FILE" 2>/dev/null || true)"
[[ -n "$TAG" ]] || fail "The Gitee release metadata does not contain tag_name."
ARCHIVE_NAME="${SKILL_NAME}-${PLATFORM}-${TAG}.zip"

asset_url() {
  local wanted="$1"
  local index=0
  local name
  while :; do
    name="$(plutil -extract "assets.${index}.name" raw -o - "$METADATA_FILE" 2>/dev/null || true)"
    [[ -n "$name" ]] || return 1
    if [[ "$name" == "$wanted" ]]; then
      plutil -extract "assets.${index}.browser_download_url" raw -o - "$METADATA_FILE" 2>/dev/null \
        || plutil -extract "assets.${index}.download_url" raw -o - "$METADATA_FILE" 2>/dev/null
      return 0
    fi
    index=$((index + 1))
  done
}

ARCHIVE_URL="$(asset_url "$ARCHIVE_NAME" || true)"
CHECKSUM_URL="$(asset_url "SHA256SUMS.txt" || true)"
[[ -n "$ARCHIVE_URL" ]] || fail "The latest Gitee release does not include $ARCHIVE_NAME."
[[ -n "$CHECKSUM_URL" ]] || fail "The latest Gitee release does not include SHA256SUMS.txt."

ARCHIVE_PATH="$TEMP_DIR/$ARCHIVE_NAME"
CHECKSUM_PATH="$TEMP_DIR/SHA256SUMS.txt"
curl --fail --location --silent --show-error "$ARCHIVE_URL" -o "$ARCHIVE_PATH" \
  || fail "Could not download $ARCHIVE_NAME."
curl --fail --location --silent --show-error "$CHECKSUM_URL" -o "$CHECKSUM_PATH" \
  || fail "Could not download SHA256SUMS.txt."

EXPECTED_SHA="$(awk -v file="$ARCHIVE_NAME" '$2 == file || $2 == "*" file { print $1; exit }' "$CHECKSUM_PATH")"
[[ "$EXPECTED_SHA" =~ ^[0-9a-fA-F]{64}$ ]] || fail "SHA256SUMS.txt has no checksum for $ARCHIVE_NAME."
ACTUAL_SHA="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
[[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]] || fail "SHA-256 verification failed for $ARCHIVE_NAME."

unzip -q "$ARCHIVE_PATH" -d "$TEMP_DIR/unpacked" || fail "Could not unpack $ARCHIVE_NAME."
PACKAGE_DIR="$TEMP_DIR/unpacked/${SKILL_NAME}-${PLATFORM}"
[[ -f "$PACKAGE_DIR/config.json" ]] || fail "Release package has an unexpected layout."
EXECUTABLE="$PACKAGE_DIR/bin/$BINARY_NAME"
[[ -x "$EXECUTABLE" ]] || fail "Release package is missing $BINARY_NAME."

mkdir -p "$CODEX_ROOT/skills"
"$EXECUTABLE" install --install-dir "$SKILL_DIR" --config-path "$CODEX_ROOT/config.toml" >/dev/null \
  || fail "Could not install the native skill package."

CONFIG_PATH="$SKILL_DIR/config.json"
[[ -f "$CONFIG_PATH" ]] || fail "Installed config.json was not found."
UPDATED_CONFIG="$TEMP_DIR/config.json"
plutil -replace apiKey -string "$API_KEY" -o "$UPDATED_CONFIG" "$CONFIG_PATH" \
  || fail "Could not update config.json."
mv -f "$UPDATED_CONFIG" "$CONFIG_PATH"
chmod 600 "$CONFIG_PATH"

INSTALLED_EXECUTABLE="$SKILL_DIR/bin/$BINARY_NAME"
[[ -x "$INSTALLED_EXECUTABLE" ]] || fail "Installed executable was not found."
"$INSTALLED_EXECUTABLE" --help >/dev/null || fail "Installed executable did not start."

printf 'Installed %s (%s) to %s\n' "$SKILL_NAME" "$TAG" "$SKILL_DIR"
printf 'Restart Codex Desktop before using the skill.\n'
