#!/usr/bin/env bash
set -euo pipefail

SKILLS_REPO=""
TOOL="both"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skills-repo) SKILLS_REPO="${2:-}"; shift 2 ;;
    --tool) TOOL="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 --skills-repo PATH [--tool codex|claude|both]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$SKILLS_REPO" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SKILLS_REPO="$(cd "$script_dir/../.." && pwd)"
else
  SKILLS_REPO="$(cd "$SKILLS_REPO" && pwd)"
fi

source_file="$SKILLS_REPO/scripts/agentic/agentic-loop.ps1"
codegraph_helper="$SKILLS_REPO/scripts/context/codegraph-context.ps1"
if [ ! -f "$source_file" ]; then
  echo "Agentic loop script not found: $source_file" >&2
  exit 1
fi

case "$(printf '%s' "$TOOL" | tr '[:upper:]' '[:lower:]')" in
  codex) TOOL="codex" ;;
  claude) TOOL="claude" ;;
  both) TOOL="both" ;;
  *) echo "--tool must be codex, claude, or both" >&2; exit 2 ;;
esac

targets=()
if [ "$TOOL" = "claude" ] || [ "$TOOL" = "both" ]; then
  targets+=("$HOME/.claude/skills/agentic-loop/scripts/agentic-loop.ps1")
fi
if [ "$TOOL" = "codex" ] || [ "$TOOL" = "both" ]; then
  targets+=("$HOME/.codex/skills/agentic-loop/scripts/agentic-loop.ps1")
fi

for target in "${targets[@]}"; do
  mkdir -p "$(dirname "$target")"
  cp "$source_file" "$target"
  echo "Installed agentic loop harness to $target"
  if [ -f "$codegraph_helper" ]; then
    context_dir="$(dirname "$(dirname "$target")")/context"
    mkdir -p "$context_dir"
    cp "$codegraph_helper" "$context_dir/codegraph-context.ps1"
    echo "Installed CodeGraph context helper to $context_dir"
  fi
done

if [ "${#targets[@]}" -eq 0 ]; then
  echo "No agentic loop target selected for tool '$TOOL'"
  exit 0
fi

preferred="${targets[0]}"
for target in "${targets[@]}"; do
  case "$target" in
    */.claude/*) preferred="$target"; break ;;
  esac
done

bin_dir="$HOME/.local/bin"
case ":$PATH:" in
  *":$HOME/bin:"*) bin_dir="$HOME/bin" ;;
esac
mkdir -p "$bin_dir"

shim="$bin_dir/agentic-loop"
cat > "$shim" <<SHIM
#!/usr/bin/env sh
if command -v pwsh >/dev/null 2>&1; then
  exec pwsh -NoProfile -File "$preferred" "\$@"
elif command -v powershell.exe >/dev/null 2>&1; then
  exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$preferred" "\$@"
else
  echo "agentic-loop requires pwsh or powershell.exe on PATH" >&2
  exit 127
fi
SHIM
chmod +x "$shim"
echo "Installed agentic-loop shell shim to $shim"
echo "agentic-loop command installed. Ensure $bin_dir is on PATH and pwsh is installed, then run: agentic-loop --help"
