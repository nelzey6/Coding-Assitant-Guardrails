import { execFileSync } from "child_process";
import type { AgenticTask } from "../context/index.js";
import type { WorkflowPolicy } from "../policy/index.js";

const DEFAULT_HUMAN_GATE_PATHS = [
  "**/migrations/**",
  "**/auth/**",
  "**/billing/**",
  "**/payment*/**",
  "**/*.sql",
];

const LOW_RISK_KINDS = ["maintenance", "discovery", "investigation"] as const;
const HIGH_RISK_KINDS = ["implementation", "architecture"] as const;

export interface FastVerifierDecision {
  allowed: boolean;
  reason: string;
}

export function getTaskScope(task: AgenticTask): string[] {
  if (!task.scope) return [];
  return (task.scope as string[]).filter((s) => s && s.trim().length > 0);
}

export function isTaskUnscoped(task: AgenticTask): boolean {
  return getTaskScope(task).length === 0;
}

// Translate a forward-slash glob into an anchored regex string.
// ** matches across path separators; * matches within a segment; ? matches one non-slash char.
export function convertToScopeRegex(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/").trim();
  let pattern = "^";
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i];
    if (c === "*") {
      if (i + 1 < normalized.length && normalized[i + 1] === "*") {
        pattern += ".*";
        i += 2;
        if (i < normalized.length && normalized[i] === "/") i++; // collapse **/
        continue;
      }
      pattern += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      pattern += "[^/]";
      i++;
      continue;
    }
    pattern += normalized[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  pattern += "$";
  return new RegExp(pattern);
}

export function testPathInScope(relativePath: string, scopeGlobs: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, "/").trim();
  for (const glob of scopeGlobs) {
    if (convertToScopeRegex(glob).test(normalized)) return true;
    // Bare directory globs (no * or ?) also match files beneath them
    if (!/[*?]/.test(glob)) {
      const dirGlob = glob.replace(/\/+$/, "") + "/**";
      if (convertToScopeRegex(dirGlob).test(normalized)) return true;
    }
  }
  return false;
}

export function getOutOfScopeFiles(worktreePath: string, scopeGlobs: string[]): string[] {
  // Intent-to-add untracked files so they appear in the diff
  try {
    execFileSync("git", ["-C", worktreePath, "add", "-N", "."], { stdio: "ignore" });
  } catch {
    // non-fatal: some worktrees may not allow it
  }
  let changed: string[];
  try {
    const out = execFileSync("git", ["-C", worktreePath, "diff", "--name-only", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    changed = out.length > 0 ? out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
  return changed.filter((f) => !testPathInScope(f, scopeGlobs));
}

function getHumanGatePaths(policy: WorkflowPolicy): string[] {
  if (policy.humanGatePaths && policy.humanGatePaths.length > 0) {
    return policy.humanGatePaths;
  }
  return DEFAULT_HUMAN_GATE_PATHS;
}

export function testFastVerifierAllowed(task: AgenticTask): FastVerifierDecision {
  const kind = task.kind ?? "";
  if (!(LOW_RISK_KINDS as readonly string[]).includes(kind)) {
    return {
      allowed: false,
      reason: `kind '${kind}' is not low-risk (only maintenance/discovery/investigation may skip the verifier)`,
    };
  }
  if (getTaskScope(task).length === 0) {
    return {
      allowed: false,
      reason: "task declares no scope, so the diff-scope rail cannot bound the change",
    };
  }
  return { allowed: true, reason: "low-risk kind with declared scope" };
}

export function testTaskIsHighRisk(task: AgenticTask, policy: WorkflowPolicy): boolean {
  const scope = getTaskScope(task);
  if (scope.length === 0) return false;
  if ((HIGH_RISK_KINDS as readonly string[]).includes(task.kind ?? "")) return true;

  const gateGlobs = getHumanGatePaths(policy);
  for (const scopeGlob of scope) {
    // Strip glob metacharacters to get the literal prefix for overlap detection
    const scopePrefix = scopeGlob.replace(/[*?].*$/, "");
    for (const gate of gateGlobs) {
      const gatePrefix = gate.replace(/[*?].*$/, "");
      if (testPathInScope(scopePrefix, gateGlobs)) return true;
      if (testPathInScope(gatePrefix, scope)) return true;
    }
  }
  return false;
}
