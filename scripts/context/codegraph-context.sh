#!/usr/bin/env bash
set -euo pipefail

output="${1:-.agent-runs/codegraph.md}"
workdir="${2:-.}"
command_override="${CODEGRAPH_CONTEXT_COMMAND:-}"
mkdir -p "$(dirname "$output")"

if ! command -v codegraph >/dev/null 2>&1; then
  cat > "$output" <<'MD'
# CodeGraph Context

CodeGraph is not available on PATH. Continue with normal repository inspection.
MD
  printf '%s\n' "$output"
  exit 0
fi

sections=""
append_section() {
  local title="$1"
  local content="$2"
  [ -z "$content" ] && return 0
  sections="$sections

## $title

$content"
}

if [ -n "$command_override" ]; then
  if body="$(cd "$workdir" && sh -lc "$command_override" 2>&1)"; then
    append_section "Custom CodeGraph Command" "\`\`\`text
$body
\`\`\`"
  fi
else
  if body="$(cd "$workdir" && codegraph files --path . --format tree --max-depth 4 2>&1)"; then
    append_section "Indexed file structure" "\`\`\`text
$body
\`\`\`"
  fi
  if body="$(cd "$workdir" && codegraph context 'Summarize this repository for an AI coding agent. Focus on main modules, scripts, tests, and likely entry points.' --path . --format markdown --no-code 2>&1)"; then
    append_section "Task context" "$body"
  fi
  if body="$(cd "$workdir" && codegraph status . 2>&1)"; then
    append_section "Index status" "\`\`\`text
$body
\`\`\`"
  fi
fi

if [ -z "$sections" ]; then
  sections="

CodeGraph was found, but no context command succeeded. Continue with normal repository inspection."
fi

cat > "$output" <<MD
# CodeGraph Context

Generated: $(date -Iseconds)
Working directory: $(cd "$workdir" && pwd)
$sections
MD

printf '%s\n' "$output"
