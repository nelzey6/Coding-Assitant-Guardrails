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

source_file="$SKILLS_REPO/scripts/ralph/ralph.ps1"
if [ ! -f "$source_file" ]; then
  echo "Ralph script not found: $source_file" >&2
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
  targets+=("$HOME/.claude/skills/ralph-prd/scripts/ralph.ps1")
fi
if [ "$TOOL" = "codex" ] || [ "$TOOL" = "both" ]; then
  targets+=("$HOME/.codex/skills/ralph-prd/scripts/ralph.ps1")
fi

for target in "${targets[@]}"; do
  mkdir -p "$(dirname "$target")"
  cp "$source_file" "$target"
  echo "Installed Ralph harness to $target"
done

if [ "${#targets[@]}" -eq 0 ]; then
  echo "No Ralph target selected for tool '$TOOL'"
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

shim="$bin_dir/ralph"
cat > "$shim" <<SHIM
#!/usr/bin/env sh
exec pwsh -NoProfile -File "$preferred" "\$@"
SHIM
chmod +x "$shim"
echo "Installed Ralph shell shim to $shim"
echo "Ralph command installed. Ensure $bin_dir is on PATH and pwsh is installed, then run: ralph --help"
