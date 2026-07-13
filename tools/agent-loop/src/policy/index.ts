import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface WorkflowPolicy {
  version: number;
  defaultDiscoveryWorkflow: string;
  defaultExecutionWorkflow: string;
  workflows: Record<string, WorkflowDef>;
  humanGates: string[];
  humanGatePaths?: string[];
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
  plannerMode?: PlannerMode;
  requiredPhases?: string[];
  defaultWorktreeMode?: boolean;
  requireCleanMainWorktree?: boolean;
  requireVerifierBeforeMerge?: boolean;
  maxRetriesPerTask?: number;
  mergeMode?: string;
  stateFile?: string;
  scratchRoot?: string;
  worktreeRoot?: string;
  worktreeBootstrap?: string[];
  worktreeBootstrapIgnore?: string[];
  checkEnvFile?: string;
  phaseAdmission?: PhaseAdmissionConfig;
}

export type PlannerMode = "auto" | "lite" | "full";

export interface PhaseAdmissionConfig {
  /** Re-run task-grill for every task, or trust a fresh planner revision until drift appears. */
  taskGrill?: "always" | "plan-aware";
  /** Run the per-task verifier for every task, or skip it for low-risk scoped work after checks. */
  verifier?: "always" | "auto";
  /** Review the remaining plan after every task, or only when deterministic drift evidence exists. */
  postTaskReview?: "always" | "on-drift";
  /** Run finalize-docs always, or only when durable documentation changed. */
  finalizeDocs?: "always" | "on-change";
  /** Re-run task-grill after every retry, or only when the failure may indicate stale understanding. */
  retryTaskGrill?: "always" | "on-drift";
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

export function resolvePlannerMode(policy: WorkflowPolicy, explicitMode?: PlannerMode): PlannerMode {
  return explicitMode ?? policy.autonomousLoop.plannerMode ?? "auto";
}

const GENERIC_HUMAN_GATE_WORDS = new Set([
  "a", "an", "and", "change", "edit", "file", "logic", "of", "or", "task", "the", "to",
]);

function normalizedWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/(?:changes|changed|changing)$/i, "change").replace(/(?:ed|ing|s)$/i, ""))
    .filter((word) => word.length > 0 && !GENERIC_HUMAN_GATE_WORDS.has(word));
}

export function matchPolicyHumanGates(policy: WorkflowPolicy, taskEvidence: string[]): string[] {
  const evidenceWords = new Set(normalizedWords(taskEvidence.join(" ")));
  return (policy.humanGates ?? []).filter((gate) => {
    const alternatives = gate.split(/\s+or\s+/i);
    return alternatives.some((alternative) => {
      const required = normalizedWords(alternative);
      return required.length > 0 && required.every((word) => evidenceWords.has(word));
    });
  });
}
