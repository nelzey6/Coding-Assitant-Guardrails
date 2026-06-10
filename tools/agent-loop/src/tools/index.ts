import { execFileSync } from "child_process";
import { existsSync } from "fs";

// Convert a task id into the filesystem/branch-safe slug the PS1 harness uses
// (`[^A-Za-z0-9._-]+` collapsed to `-`, trimmed). Branches and worktree paths
// are derived from this, so it must match Reset-AgenticTask exactly.
export function safeSlug(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "task" : slug;
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { encoding: "utf-8", cwd }).trim();
}

export function gitBranchExists(branch: string, cwd?: string): boolean {
  if (!branch) return false;
  try {
    return git(["branch", "--list", branch], cwd).length > 0;
  } catch {
    return false;
  }
}

export function worktreeExists(path: string): boolean {
  return existsSync(path);
}

export function removeWorktree(path: string, cwd?: string): void {
  git(["worktree", "remove", "--force", path], cwd);
}

export function deleteBranch(branch: string, cwd?: string): void {
  git(["branch", "-D", branch], cwd);
}
