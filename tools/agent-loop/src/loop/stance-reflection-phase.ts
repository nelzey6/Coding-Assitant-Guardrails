import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { LoopError, git, emitTokenUsage, type LoopConfig } from "./index.js";
import { writeStanceReflectionPrompt } from "../prompts/index.js";
import { appendEvent } from "../events/index.js";
import { invokeAgentWithLog } from "../agent/index.js";
import { loadState, getTasks, writeState, type Task } from "../state/index.js";

export interface StanceReflectionResult {
  mode: "stance";
  verdict: "reconfirm" | "readjust" | "reassess" | "needs_human";
  summary?: string;
  evidence?: string[];
  unresolved_risks?: string[];
  stance?: Record<string, unknown>;
}

export async function runStanceReflectionPhase(
  cfg: Required<LoopConfig>,
  agentCallCounter: { count: number },
  task: Task,
  runDir: string,
  worktreePath: string,
  codeGraphFile: string,
  decisions: Record<string, unknown>[]
): Promise<{ result: StanceReflectionResult; resultFile: string }> {
  const worktreeSnapshot = (): string => git(["status", "--porcelain", "--untracked-files=all"], worktreePath)
    .split(/\r?\n/)
    .filter(Boolean)
    .sort()
    .join("\n");
  const baseline = worktreeSnapshot();

  const promptFile = join(runDir, "stance-reflection.md");
  const resultFile = join(runDir, "stance-reflection.json");
  const logFile = join(runDir, "stance-reflection.log");
  writeStanceReflectionPrompt(promptFile, {
    repoRoot: cfg.repoRoot, task, resultFile,
    codeGraphFile, decisionGrillDecisions: decisions,
  });
  appendEvent(cfg.repoRoot, "stance_reflection_started", { task: task.id, prompt: promptFile, resultFile }, cfg.runsRoot, cfg.stateFile);
  agentCallCounter.count++;
  emitTokenUsage(cfg, await invokeAgentWithLog(promptFile, cfg.grillAgent, worktreePath, logFile, "stance-reflection"), task.id);
  if (!existsSync(resultFile)) throw new LoopError(`Stance reflection did not write ${resultFile}`);
  const afterReflection = worktreeSnapshot();
  if (afterReflection !== baseline) {
    throw new LoopError(`Stance reflection edited the worktree before implementation for ${task.id}\nBefore:\n${baseline || "(clean)"}\nAfter:\n${afterReflection || "(clean)"}`);
  }
  const result = JSON.parse(readFileSync(resultFile, "utf-8")) as StanceReflectionResult;
  if (result.mode !== "stance" || !["reconfirm", "readjust", "reassess", "needs_human"].includes(result.verdict)) {
    throw new LoopError(`Invalid stance reflection result for ${task.id}`);
  }
  if (!result.summary?.trim() || !(result.evidence?.length) || !result.stance) {
    throw new LoopError(`Stance reflection for ${task.id} lacks summary, evidence, or stance`);
  }
  appendEvent(cfg.repoRoot, "stance_reflection_finished", { task: task.id, verdict: result.verdict, summary: result.summary }, cfg.runsRoot, cfg.stateFile);
  if (result.verdict === "needs_human") throw new LoopError(`Stance reflection needs human input for ${task.id}: ${result.summary ?? ""}`);
  if (result.verdict === "reassess") {
    throw new LoopError(`Stance reflection could not establish an implementation stance for ${task.id} after its self-challenge cycle`);
  }

  const approvedFile = join(runDir, "approved-stance.json");
  writeFileSync(approvedFile, JSON.stringify(result, null, 2) + "\n", "utf-8");
  const state = loadState(cfg.repoRoot, cfg.stateFile)!;
  const current = getTasks(state).find((t) => t.id === task.id);
  if (current) current.approvedStanceFile = approvedFile;
  writeState(cfg.repoRoot, state, cfg.stateFile);
  appendEvent(cfg.repoRoot, "stance_approved", { task: task.id, resultFile: approvedFile }, cfg.runsRoot, cfg.stateFile);
  return { result, resultFile: approvedFile };
}
