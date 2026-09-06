#!/usr/bin/env tsx
import { DEFAULT_LATENCY_POLICY, phaseLatencyDecision, resolveLatencyPolicy } from "../../tools/agent-loop/src/latency/index.js";
import type { WorkflowPolicy } from "../../tools/agent-loop/src/policy/index.js";

const policy = { autonomousLoop: {} } as WorkflowPolicy;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const defaults = resolveLatencyPolicy(policy);
assert(JSON.stringify(defaults) === JSON.stringify(DEFAULT_LATENCY_POLICY), "missing policy should resolve canonical latency defaults");
assert(defaults.directTargetSeconds === 60 && defaults.plannedTargetSeconds === 180 && defaults.complexTargetSeconds === 300, "run targets drifted");
assert(defaults.phaseTargetsSeconds.executor === 140 && defaults.phaseTargetsSeconds.verifier === 45, "phase targets drifted");

assert(!phaseLatencyDecision("executor", 139_000, defaults).exceeded, "phase under target marked exceeded");
assert(phaseLatencyDecision("executor", 141_000, defaults).exceeded, "phase over target not marked exceeded");

console.log("latency-policy smoke passed");
