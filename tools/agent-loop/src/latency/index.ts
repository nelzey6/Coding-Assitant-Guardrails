import type { LatencyPolicy, WorkflowPolicy } from "../policy/index.js";

export type LatencyRoute = "direct" | "planned" | "complex";
export type LatencyPhase = "planner" | "stance" | "executor" | "checks" | "verifier";

export const DEFAULT_LATENCY_POLICY: LatencyPolicy = {
  directTargetSeconds: 60,
  plannedTargetSeconds: 180,
  complexTargetSeconds: 300,
  phaseTargetsSeconds: {
    planner: 40,
    stance: 35,
    executor: 140,
    checks: 25,
    verifier: 45,
  },
};

export function resolveLatencyPolicy(policy: WorkflowPolicy): LatencyPolicy {
  const configured = policy.autonomousLoop.latency;
  return {
    ...DEFAULT_LATENCY_POLICY,
    ...(configured ?? {}),
    phaseTargetsSeconds: {
      ...DEFAULT_LATENCY_POLICY.phaseTargetsSeconds,
      ...(configured?.phaseTargetsSeconds ?? {}),
    },
  };
}

export function normalizeLatencyPhase(phase: string): LatencyPhase | null {
  if (phase.startsWith("planner")) return "planner";
  if (phase.startsWith("stance")) return "stance";
  if (phase === "executor") return "executor";
  if (phase === "checks") return "checks";
  if (phase.startsWith("verifier")) return "verifier";
  return null;
}

export function phaseLatencyDecision(phaseName: string, durationMs: number, policy: LatencyPolicy): {
  phase: LatencyPhase | null;
  durationMs: number;
  targetSeconds: number | null;
  exceeded: boolean;
} {
  const phase = normalizeLatencyPhase(phaseName);
  const targetSeconds = phase ? policy.phaseTargetsSeconds[phase] : null;
  return { phase, durationMs, targetSeconds, exceeded: targetSeconds != null && durationMs > targetSeconds * 1000 };
}
