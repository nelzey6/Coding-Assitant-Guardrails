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

agent_loop_dir="$SKILLS_REPO/tools/agent-loop"
agent_index_ts="$agent_loop_dir/src/index.ts"
tsx_cli="$agent_loop_dir/node_modules/tsx/dist/cli.mjs"

if [ ! -f "$agent_index_ts" ]; then
  echo "TS agent-loop entry point not found: $agent_index_ts" >&2
  exit 1
fi
if [ ! -f "$tsx_cli" ]; then
  echo "tsx not found at $tsx_cli — run 'npm install' inside $agent_loop_dir first." >&2
  exit 1
fi

# Verify node >= 20
if ! command -v node >/dev/null 2>&1; then
  echo "node is not on PATH. Install Node.js >= 20 before running setup." >&2
  exit 1
fi
node_major="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
if [ "$node_major" -lt 20 ]; then
  echo "node $(node --version) is too old. agentic-loop requires Node.js >= 20." >&2
  exit 1
fi
echo "node $(node --version) detected."

codegraph_helper="$SKILLS_REPO/scripts/context/codegraph-context.ps1"

case "$(printf '%s' "$TOOL" | tr '[:upper:]' '[:lower:]')" in
  codex) TOOL="codex" ;;
  claude) TOOL="claude" ;;
  both) TOOL="both" ;;
  *) echo "--tool must be codex, claude, or both" >&2; exit 2 ;;
esac

targets=()
if [ "$TOOL" = "claude" ] || [ "$TOOL" = "both" ]; then
  targets+=("$HOME/.claude/skills/agentic-loop")
fi
if [ "$TOOL" = "codex" ] || [ "$TOOL" = "both" ]; then
  targets+=("$HOME/.codex/skills/agentic-loop")
fi

for target_dir in "${targets[@]}"; do
  mkdir -p "$target_dir"
  printf '%s' "$agent_loop_dir" > "$target_dir/AGENT_LOOP_LOCATION"
  echo "Registered agentic-loop location at $target_dir"
  if [ -f "$codegraph_helper" ]; then
    context_dir="$target_dir/context"
    mkdir -p "$context_dir"
    cp "$codegraph_helper" "$context_dir/codegraph-context.ps1"
    echo "Installed CodeGraph context helper to $context_dir"
  fi
done

if [ "${#targets[@]}" -eq 0 ]; then
  echo "No agentic loop target selected for tool '$TOOL'"
  exit 0
fi

node_bin="$(command -v node)"

bin_dir="$HOME/.local/bin"
case ":$PATH:" in
  *":$HOME/bin:"*) bin_dir="$HOME/bin" ;;
esac
mkdir -p "$bin_dir"

shim="$bin_dir/agentic-loop"
cat > "$shim" <<SHIM
#!/usr/bin/env sh
exec "$node_bin" "$tsx_cli" "$agent_index_ts" "\$@"
SHIM
chmod +x "$shim"
echo "Installed agentic-loop shell shim to $shim"
echo "agentic-loop installed (TS runner). Ensure $bin_dir is on PATH, then run: agentic-loop --help"
