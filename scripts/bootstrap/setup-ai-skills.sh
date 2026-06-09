#!/usr/bin/env bash
set -euo pipefail

ORIGINAL_ARGS=("$@")
TOOL="${TOOL:-both}"
SKILLS_REPO="${SKILLS_REPO:-}"
DESTINATION="${DESTINATION:-}"
UPDATE="${UPDATE:-true}"
FORCE_TEMPLATE_OVERWRITE="${FORCE_TEMPLATE_OVERWRITE:-false}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tool)
      TOOL="${2:-}"
      shift 2
      ;;
    --skills-repo)
      SKILLS_REPO="${2:-}"
      shift 2
      ;;
    --destination)
      DESTINATION="${2:-}"
      shift 2
      ;;
    --update)
      UPDATE="true"
      shift
      ;;
    --no-update)
      UPDATE="false"
      shift
      ;;
    --force-template-overwrite)
      FORCE_TEMPLATE_OVERWRITE="true"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--tool codex|claude|both] [--destination REPO_PATH] [--update|--no-update] [--force-template-overwrite]"
      echo "By default, the script pulls latest changes in this git checkout using its configured remote, then re-runs itself so updated scripts are used."
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

case "$(printf '%s' "$TOOL" | tr '[:upper:]' '[:lower:]')" in
  codex) TOOL="codex" ;;
  claude) TOOL="claude" ;;
  both) TOOL="both" ;;
  *)
    echo "--tool must be codex, claude, or both" >&2
    exit 1
    ;;
esac

install_skills() {
  local tool_name="$1"
  local target="$2"
  local count=0

  mkdir -p "$target"

  while IFS= read -r -d '' skill_file; do
    skill_dir="$(dirname "$skill_file")"
    skill_name="$(basename "$skill_dir")"

    rm -rf "$target/$skill_name"
    cp -R "$skill_dir" "$target/$skill_name"
    count=$((count + 1))
  done < <(
    find "$SKILLS_REPO/skills" \
      -path '*/deprecated/*' -prune -o \
      -path '*/node_modules/*' -prune -o \
      -name SKILL.md -type f -print0
  )

  echo "Installed $count $tool_name skills to $target"
}

copy_template() {
  local source="$1"
  local destination="$2"

  if [ ! -f "$source" ]; then
    echo "Template not found: $source" >&2
    exit 1
  fi

  cp "$source" "$destination"
  echo "Wrote $destination"
}

copy_template_if_missing() {
  local source="$1"
  local destination="$2"

  if [ ! -f "$source" ]; then
    echo "Template not found: $source" >&2
    exit 1
  fi

  if [ -e "$destination" ]; then
    echo "Keeping existing $destination"
    return 0
  fi

  cp "$source" "$destination"
  echo "Created $destination"
}

copy_repo_templates() {
  local template_root="$1"
  local destination_root="$2"

  mkdir -p "$destination_root"

  if [ "$TOOL" = "codex" ] || [ "$TOOL" = "both" ]; then
    if [ "$FORCE_TEMPLATE_OVERWRITE" = "true" ]; then
      copy_template "$template_root/AGENTS.md" "$destination_root/AGENTS.md"
    else
      copy_template_if_missing "$template_root/AGENTS.md" "$destination_root/AGENTS.md"
    fi
  fi

  if [ "$TOOL" = "claude" ] || [ "$TOOL" = "both" ]; then
    if [ "$FORCE_TEMPLATE_OVERWRITE" = "true" ]; then
      copy_template "$template_root/CLAUDE.md" "$destination_root/CLAUDE.md"
    else
      copy_template_if_missing "$template_root/CLAUDE.md" "$destination_root/CLAUDE.md"
    fi
  fi

  copy_template_if_missing "$template_root/PROJECT.md" "$destination_root/PROJECT.md"
  copy_template_if_missing "$template_root/CONTEXT.md" "$destination_root/CONTEXT.md"

  mkdir -p "$destination_root/.agent-policy"
  copy_template_if_missing "$template_root/agent-policy/workflow-policy.json" "$destination_root/.agent-policy/workflow-policy.json"
}

add_gitignore_entry() {
  local destination_root="$1"
  local pattern="$2"
  local gitignore="$destination_root/.gitignore"

  touch "$gitignore"

  if grep -Fxq "$pattern" "$gitignore"; then
    echo "$pattern already present in $gitignore"
  else
    printf '%s\n' "$pattern" >> "$gitignore"
    echo "Added $pattern to $gitignore"
  fi
}

if [ -z "$SKILLS_REPO" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SKILLS_REPO="$(cd "$script_dir/../.." && pwd)"
else
  SKILLS_REPO="$(cd "$SKILLS_REPO" && pwd)"
fi

if [ "$UPDATE" = "true" ] && [ "${SETUP_AI_SKILLS_REEXECED:-}" != "1" ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "--update requires git on PATH" >&2
    exit 1
  fi

  if [ ! -d "$SKILLS_REPO/.git" ]; then
    echo "--update requires $SKILLS_REPO to be a git checkout" >&2
    exit 1
  fi

  echo "Updating skills repo at $SKILLS_REPO using its configured git remote"
  git -C "$SKILLS_REPO" fetch --prune
  git -C "$SKILLS_REPO" pull --ff-only

  script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  echo "Re-running updated installer"
  SETUP_AI_SKILLS_REEXECED=1 exec "$script_path" "${ORIGINAL_ARGS[@]}"
fi

if [ ! -d "$SKILLS_REPO/skills" ]; then
  echo "Skills directory not found: $SKILLS_REPO/skills. Run this script from the skills repository checkout or pass --skills-repo PATH." >&2
  exit 1
fi

if [ "$TOOL" = "codex" ] || [ "$TOOL" = "both" ]; then
  install_skills "Codex" "$HOME/.codex/skills"
fi

if [ "$TOOL" = "claude" ] || [ "$TOOL" = "both" ]; then
  install_skills "Claude" "$HOME/.claude/skills"
fi

ralph_setup="$SKILLS_REPO/scripts/ralph/setup-ralph.sh"
if [ -f "$ralph_setup" ]; then
  bash "$ralph_setup" --skills-repo "$SKILLS_REPO" --tool "$TOOL"
fi

agentic_setup="$SKILLS_REPO/scripts/agentic/setup-agentic.sh"
if [ -f "$agentic_setup" ]; then
  bash "$agentic_setup" --skills-repo "$SKILLS_REPO" --tool "$TOOL"
fi

if [ -n "$DESTINATION" ]; then
  template_root="$SKILLS_REPO/templates"
  if [ ! -d "$template_root" ]; then
    echo "Templates directory not found: $template_root" >&2
    exit 1
  fi

  mkdir -p "$DESTINATION"
  destination_root="$(cd "$DESTINATION" && pwd)"
  copy_repo_templates "$template_root" "$destination_root"
  add_gitignore_entry "$destination_root" ".agent-runs/"
  add_gitignore_entry "$destination_root" ".worktrees/"
  add_gitignore_entry "$destination_root" "agentic.json"
  echo "Repo templates copied to $destination_root"
fi

echo "Restart Codex or Claude to refresh available skills."
if [ "$UPDATE" = "true" ]; then
  echo "Installed after updating $SKILLS_REPO. Use --destination <repo> to seed missing repo templates without overwriting existing markdowns."
else
  echo "Repo templates are available in $SKILLS_REPO/templates. Use --destination <repo> to seed missing repo templates without overwriting existing markdowns."
fi
