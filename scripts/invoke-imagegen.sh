#!/bin/bash
# macOS runner: keep lifecycle polling inside one local process.

write_stderr() {
  printf '%s\n' "$1" >&2
}

json_escape() {
  printf '%s' "$1" | perl -0777 -pe 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g'
}

absolute_path() {
  local directory base
  directory=$(cd -P "$(dirname "$1")" 2>/dev/null && pwd) || return 1
  base=$(basename "$1")
  printf '%s/%s\n' "$directory" "$base"
}

write_failure() {
  local exit_code="$1" message="$2" total_ms="$3" temporary
  temporary="${STATUS_FILE}.$$.$RANDOM.tmp"
  printf '{"version":1,"status":"failed","command":"%s","exit_code":%s,"saved":[],"timing_ms":{"total":%s},"error":{"message":"%s"},"request_id":null}\n' \
    "$(json_escape "$COMMAND")" "$exit_code" "$total_ms" "$(json_escape "$message")" > "$temporary"
  mv -f "$temporary" "$STATUS_FILE"
}

now_ms() {
  # macOS ships Perl even on systems without a separate developer runtime.
  perl -MTime::HiRes=time -e 'printf "%.0f", time * 1000'
}

if [ "$#" -lt 1 ]; then
  write_stderr "Usage: invoke-imagegen.sh <generate|edit> --status-file <path> [--timeout-seconds <1-600>] [image arguments]"
  exit 2
fi

COMMAND="$1"
shift
case "$COMMAND" in
  generate|edit) ;;
  *) write_stderr "Command must be generate or edit."; exit 2 ;;
esac

STATUS_FILE=""
# Keep the local wait bound at the supported maximum so it never truncates the configured API deadline.
TIMEOUT_SECONDS=600
EXECUTABLE_PATH=""
IMAGE_ARGUMENTS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --status-file)
      [ "$#" -ge 2 ] || { write_stderr "--status-file requires a path."; exit 2; }
      [ -z "$STATUS_FILE" ] || { write_stderr "Pass --status-file only once to the runner."; exit 2; }
      STATUS_FILE="$2"
      shift 2
      ;;
    --timeout-seconds)
      [ "$#" -ge 2 ] || { write_stderr "--timeout-seconds requires a value."; exit 2; }
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --executable-path)
      [ "$#" -ge 2 ] || { write_stderr "--executable-path requires a path."; exit 2; }
      EXECUTABLE_PATH="$2"
      shift 2
      ;;
    --)
      shift
      IMAGE_ARGUMENTS+=("$@")
      break
      ;;
    *)
      [ "$1" != "--status-file" ] || { write_stderr "Pass --status-file only to the runner."; exit 2; }
      IMAGE_ARGUMENTS+=("$1")
      shift
      ;;
  esac
done

case "$TIMEOUT_SECONDS" in
  ''|*[!0-9]*) write_stderr "--timeout-seconds must be an integer from 1 to 600."; exit 2 ;;
esac
if [ "$TIMEOUT_SECONDS" -lt 1 ] || [ "$TIMEOUT_SECONDS" -gt 600 ]; then
  write_stderr "--timeout-seconds must be an integer from 1 to 600."
  exit 2
fi
if [ -z "$STATUS_FILE" ]; then
  write_stderr "--status-file is required."
  exit 2
fi

SCRIPT_DIR=$(cd -P "$(dirname "$0")" && pwd)
SKILL_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
if [ -z "$EXECUTABLE_PATH" ]; then
  case "$(uname -m)" in
    arm64) EXECUTABLE_PATH="$SKILL_ROOT/bin/niucodes-image-gen-macos-arm64" ;;
    x86_64) EXECUTABLE_PATH="$SKILL_ROOT/bin/niucodes-image-gen-macos-x64" ;;
    *) write_stderr "Unsupported macOS architecture: $(uname -m)"; exit 1 ;;
  esac
fi

STATUS_DIR=$(dirname "$STATUS_FILE")
mkdir -p "$STATUS_DIR" || { write_stderr "Unable to create status directory: $STATUS_DIR"; exit 1; }
STATUS_FILE=$(absolute_path "$STATUS_FILE") || { write_stderr "Unable to resolve status file path."; exit 1; }
if [ ! -f "$EXECUTABLE_PATH" ]; then
  STARTED_MS=$(now_ms)
  write_failure 1 "Bundled executable was not found: $EXECUTABLE_PATH" 0
  cat "$STATUS_FILE"
  exit 1
fi

STARTED_MS=$(now_ms)
STDOUT_FILE="${STATUS_FILE}.$$.$RANDOM.stdout"
STDERR_FILE="${STATUS_FILE}.$$.$RANDOM.stderr"
cleanup() { rm -f "$STDOUT_FILE" "$STDERR_FILE"; }
trap cleanup EXIT

"$EXECUTABLE_PATH" "$COMMAND" "${IMAGE_ARGUMENTS[@]}" --status-file "$STATUS_FILE" >"$STDOUT_FILE" 2>"$STDERR_FILE" &
CHILD_PID=$!
FINAL_READY=0
TIMED_OUT=0

while kill -0 "$CHILD_PID" 2>/dev/null; do
  if [ -f "$STATUS_FILE" ] && grep -Eq '"status"[[:space:]]*:[[:space:]]*"(success|failed)"' "$STATUS_FILE"; then
    FINAL_READY=1
  fi
  ELAPSED_MS=$(( $(now_ms) - STARTED_MS ))
  if [ "$ELAPSED_MS" -ge $(( TIMEOUT_SECONDS * 1000 )) ]; then
    TIMED_OUT=1
    kill "$CHILD_PID" 2>/dev/null || true
    break
  fi
  sleep 1
done

wait "$CHILD_PID"
CHILD_EXIT_CODE=$?
if [ -s "$STDERR_FILE" ]; then
  cat "$STDERR_FILE" >&2
fi
TOTAL_MS=$(( $(now_ms) - STARTED_MS ))

if [ "$TIMED_OUT" -eq 1 ]; then
  write_failure 124 "Timed out after $TIMEOUT_SECONDS seconds." "$TOTAL_MS"
  cat "$STATUS_FILE"
  exit 124
fi

if [ -f "$STATUS_FILE" ] && grep -Eq '"status"[[:space:]]*:[[:space:]]*"(success|failed)"' "$STATUS_FILE"; then
  if [ "$CHILD_EXIT_CODE" -eq 0 ] && grep -Eq '"status"[[:space:]]*:[[:space:]]*"success"' "$STATUS_FILE"; then
    cat "$STATUS_FILE"
    exit 0
  fi
  if [ "$CHILD_EXIT_CODE" -ne 0 ] && grep -Eq '"status"[[:space:]]*:[[:space:]]*"success"' "$STATUS_FILE"; then
    write_failure "$CHILD_EXIT_CODE" "Executable returned a nonzero exit code." "$TOTAL_MS"
  fi
  cat "$STATUS_FILE"
  exit "$CHILD_EXIT_CODE"
fi

write_failure "$CHILD_EXIT_CODE" "Executable exited without a final status result." "$TOTAL_MS"
cat "$STATUS_FILE"
exit "$CHILD_EXIT_CODE"
