import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface WorkflowPolicy {
  version: number;
  defaultDiscoveryWorkflow: string;
  defaultExecutionWorkflow: string;
  workflows: Record<string, WorkflowDef>;
  humanGates: string[];
  autonomousLoop: AutonomousLoopConfig;
  verifierRules?: Record<string, unknown>;
}

export interface WorkflowDef {
  skillName: string;
  phase: string;
  routeWhen?: string[];
  autoLoopUse?: string;
}

export interface AutonomousLoopConfig {
  requiredPhases?: string[];
  defaultWorktreeMode?: boolean;
  requireCleanMainWorktree?: boolean;
  requireVerifierBeforeMerge?: boolean;
  maxRetriesPerTask?: number;
  mergeMode?: string;
  stateFile?: string;
  scratchRoot?: string;
  worktreeRoot?: string;
}

const FALLBACK_POLICY_RELATIVE = "templates/agent-policy/workflow-policy.json";
const LOCAL_POLICY_RELATIVE = ".agent-policy/workflow-policy.json";

export function loadPolicy(repoRoot: string): WorkflowPolicy {
  const localPath = join(repoRoot, LOCAL_POLICY_RELATIVE);
  const fallbackPath = join(repoRoot, FALLBACK_POLICY_RELATIVE);

  const policyPath = existsSync(localPath) ? localPath : fallbackPath;
  if (!existsSync(policyPath)) {
    throw new Error(
      `Workflow policy not found at ${localPath} or ${fallbackPath}`
    );
  }

  return JSON.parse(readFileSync(policyPath, "utf-8")) as WorkflowPolicy;
}

export function allowedWorkflowNames(policy: WorkflowPolicy): string[] {
  return Object.keys(policy.workflows);
}
