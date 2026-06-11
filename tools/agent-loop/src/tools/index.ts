import { execFileSync } from "child_process";
import { existsSync } from "fs";

// Convert a task id into the filesystem/branch-safe slug the PS1 harness uses
// (`[^A-Za-z0-9._-]+` collapsed to `-`, trimmed). Branches and worktree paths
// are derived from this, so it must match Reset-AgenticTask exactly.
export function safeSlug(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "task" : slug;
}

// Run git, returning trimmed stdout. Throws GitError on non-zero exit so callers
// can surface stderr (merge conflicts, etc.) instead of a bare exit code.
export class GitError extends Error {
  constructor(message: string, public readonly output: string) {
    super(message);
    this.name = "GitError";
  }
}

export function git(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, { encoding: "utf-8", cwd, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = [e?.stdout, e?.stderr].filter(Boolean).join("\n").trim();
    throw new GitError(`git ${args.join(" ")} failed: ${out || (e?.message ?? String(err))}`, out);
  }
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

// Force-remove (used by reset-task on possibly-dirty stale worktrees).
export function removeWorktree(path: string, cwd?: string): void {
  git(["worktree", "remove", "--force", path], cwd);
}

// Clean removal (used by accept after a successful integration).
export function removeWorktreeClean(path: string, cwd?: string): void {
  git(["worktree", "remove", path], cwd);
}

export function deleteBranch(branch: string, cwd?: string): void {
  git(["branch", "-D", branch], cwd);
}

export function createWorktree(branch: string, path: string, base: string, cwd?: string): void {
  git(["worktree", "add", "-b", branch, path, base], cwd);
}

export function isWorkingTreeClean(cwd?: string): boolean {
  return git(["status", "--porcelain"], cwd).length === 0;
}

export function workingTreeStatusShort(cwd?: string): string {
  return git(["status", "--short"], cwd);
}

export function revParse(ref: string, cwd?: string): string {
  return git(["rev-parse", ref], cwd);
}

export type MergeMode = "ff-only" | "no-ff" | "cherry-pick" | "apply";

export const MERGE_MODES: MergeMode[] = ["ff-only", "no-ff", "cherry-pick", "apply"];

// The git command a given merge mode runs to integrate `branch`, as a label.
export function mergeModeLabel(mode: MergeMode, branch: string): string {
  switch (mode) {
    case "ff-only": return `git merge --ff-only ${branch}`;
    case "no-ff": return `git merge --no-ff ${branch}`;
    case "cherry-pick": return `git cherry-pick ${branch}`;
    case "apply": return `git cherry-pick --no-commit ${branch}`;
  }
}

// Integrate `branch` into the current HEAD using the chosen mode. Throws GitError
// on conflict/failure, leaving the branch and worktree intact for recovery.
export function integrateBranch(mode: MergeMode, branch: string, taskId: string, cwd?: string): void {
  switch (mode) {
    case "ff-only": git(["merge", "--ff-only", branch], cwd); break;
    case "no-ff": git(["merge", "--no-ff", branch, "-m", `agentic: accept ${taskId}`], cwd); break;
    case "cherry-pick": git(["cherry-pick", branch], cwd); break;
    case "apply": git(["cherry-pick", "--no-commit", branch], cwd); break;
  }
}
