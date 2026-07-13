import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { AgenticState } from "../state/index.js";

export interface WorkflowPolicy {
  version: number;
  defaultDiscoveryWorkflow: string;
  defaultExecutionWorkflow: string;
  workflows: Record<string, WorkflowDef>;
  humanGates: Array<string | HumanGateRule>;
  humanGatePaths?: string[];
  autonomousLoop: AutonomousLoopConfig;
  verifierRules?: Record<string, unknown>;
}

export interface HumanGateRule {
  label: string;
  /** Every phrase must be present in task evidence. */
  all?: string[];
  /** At least one phrase must be present in task evidence. */
  any?: string[];
}

export interface WorkflowDef {
  skillName: string;
  phase: string;
  routeWhen?: string[];
  autoLoopUse?: string;
}

export interface AutonomousLoopConfig {
  plannerMode?: PlannerMode;
  requireCleanMainWorktree?: boolean;
  maxRetriesPerTask?: number;
  worktreeBootstrap?: string[];
  worktreeBootstrapIgnore?: string[];
  checkEnvFile?: string;
  phaseAdmission?: PhaseAdmissionConfig;
}

export type PlannerMode = "auto" | "lite" | "full";

export interface PhaseAdmissionConfig {
  /** Run the per-task verifier for every task, or skip it for low-risk scoped work after checks. */
  verifier?: "always" | "auto";
  /** Run finalize-docs always, or only when durable documentation changed. */
  finalizeDocs?: "always" | "on-change";
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

export interface EffectivePlannerMode {
  mode: "full" | "lite";
  source: "policy" | "adaptive";
  reason: string;
}

export function resolveEffectivePlannerMode(
  policy: WorkflowPolicy,
  state: AgenticState,
  priorFailureAnalysisFile = "",
): EffectivePlannerMode {
  const configured = policy.autonomousLoop.plannerMode ?? "auto";
  if (configured === "full") return { mode: "full", source: "policy", reason: "policy configured full planner" };
  if (configured === "lite") return { mode: "lite", source: "policy", reason: "policy configured planner-lite" };
  if (priorFailureAnalysisFile) return { mode: "full", source: "adaptive", reason: "replan after failure requires full planner context" };
  if ((state.planRevision ?? 0) > 0) return { mode: "full", source: "adaptive", reason: "non-initial planning revision requires full planner context" };

  const goal = (state.goal ?? "").trim();
  const lowRiskGoal = goal.length <= 240
    && /\b(add|update|change|edit|document|docs?|wording|sentence|readme|markdown)\b/i.test(goal)
    && /(?:^|\s|[`"'(])(?:[\w./-]+\.md|docs?\/)[\w./-]*/i.test(goal)
    && !/\b(api|architecture|auth|billing|database|delete|dependency|migration|package|permission|public|refactor|schema|security|service|transport|worktree)\b/i.test(goal);
  return lowRiskGoal
    ? { mode: "lite", source: "adaptive", reason: "short documentation/maintenance goal with no elevated-risk terms" }
    : { mode: "full", source: "adaptive", reason: "goal does not meet conservative planner-lite admission" };
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
  const phraseMatches = (phrase: string): boolean => {
    const required = normalizedWords(phrase);
    return required.length > 0 && required.every((word) => evidenceWords.has(word));
  };
  return (policy.humanGates ?? []).flatMap((gate) => {
    if (typeof gate === "string") {
      return gate.split(/\s+or\s+/i).some(phraseMatches) ? [gate] : [];
    }
    const all = gate.all ?? [];
    const any = gate.any ?? [];
    if (all.length + any.length === 0) return [];
    const matches = all.every(phraseMatches) && (any.length === 0 || any.some(phraseMatches));
    return matches ? [gate.label] : [];
  });
}
