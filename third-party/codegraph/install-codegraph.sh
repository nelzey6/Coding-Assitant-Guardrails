#!/usr/bin/env bash
set -euo pipefail

force="${1:-}"
if command -v codegraph >/dev/null 2>&1 && [ "$force" != "--force" ]; then
  echo "CodeGraph already available on PATH: $(command -v codegraph)"
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "CodeGraph is not installed and npm was not found. Install CodeGraph using its upstream instructions, then ensure 'codegraph' is on PATH." >&2
  exit 1
fi

echo "Installing CodeGraph CLI with npm..."
npm install -g codegraph

if ! command -v codegraph >/dev/null 2>&1; then
  echo "CodeGraph install finished but 'codegraph' is still not on PATH. Open a new terminal or check npm global bin path." >&2
  exit 1
fi

echo "CodeGraph installed: $(command -v codegraph)"
