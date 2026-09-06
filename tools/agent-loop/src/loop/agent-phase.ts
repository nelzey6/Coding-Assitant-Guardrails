import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { appendEvent } from "../events/index.js";
import { invokeAgentWithLog, type AgentConfig, type AgentInvocationResult } from "../agent/index.js";
import { CheckoutMutationError, withUnchangedCheckout } from "../tools/index.js";

export interface AgentPhaseOptions {
  repoRoot: string;
  runsRoot: string;
  stateFile: string;
  worktreeRoot: string;
  ignoredParentPaths?: string[];
  promptFile: string;
  agent: AgentConfig;
  workingDirectory: string;
  logFile: string;
  phase: string;
  taskId?: string;
}

export class AgentPhaseMutationError extends CheckoutMutationError {
  constructor(
    mutation: CheckoutMutationError,
    public readonly phase: string,
    public readonly evidenceFile: string,
  ) {
    super(mutation.before, mutation.after, mutation.actionError);
    this.name = "AgentPhaseMutationError";
  }
}

export async function invokeAgentPhase(options: AgentPhaseOptions): Promise<AgentInvocationResult> {
  const ignoredPaths = [
    options.stateFile,
    options.runsRoot,
    options.worktreeRoot,
    ...(options.ignoredParentPaths ?? []),
  ];
  try {
    return await withUnchangedCheckout(
      options.repoRoot,
      async () => {
        const invoke = () => invokeAgentWithLog(options.promptFile, options.agent, options.workingDirectory, options.logFile, options.phase);
        if (!options.phase.startsWith("verifier")) return invoke();
        try {
          return await withUnchangedCheckout(options.workingDirectory, invoke);
        } catch (error) {
          if (!(error instanceof CheckoutMutationError)) throw error;
          const evidenceFile = join(dirname(options.logFile), `candidate-mutation-${options.phase}.txt`);
          writeFileSync(evidenceFile, JSON.stringify({ before: error.before, after: error.after }, null, 2), "utf-8");
          appendEvent(options.repoRoot, "candidate_mutated", { task: options.taskId, phase: options.phase, evidenceFile }, options.runsRoot, options.stateFile);
          throw new Error(`Reviewer changed the checked candidate. Worktree retained; evidence: ${evidenceFile}`);
        }
      },
      ignoredPaths,
    );
  } catch (error) {
    if (!(error instanceof CheckoutMutationError)) throw error;
    const evidenceFile = join(dirname(options.logFile), `parent-worktree-mutation-${options.phase}.txt`);
    writeFileSync(evidenceFile, [
      `Protected checkout changed during ${options.phase}.`,
      "Harness stopped without restoring or hiding the mutation.",
      "",
      `HEAD before: ${error.before.head}`,
      `HEAD after: ${error.after.head}`,
      `Fingerprint before: ${error.before.fingerprint}`,
      `Fingerprint after: ${error.after.fingerprint}`,
      `Status before: ${error.before.status || "clean"}`,
      `Status after: ${error.after.status || "clean"}`,
      `Untracked before: ${error.before.untrackedPaths.join(", ") || "none"}`,
      `Untracked after: ${error.after.untrackedPaths.join(", ") || "none"}`,
      ...(error.actionError ? ["", `Agent also failed: ${error.actionError instanceof Error ? error.actionError.message : String(error.actionError)}`] : []),
    ].join("\n"), "utf-8");
    appendEvent(options.repoRoot, "parent_worktree_mutated", {
      ...(options.taskId ? { task: options.taskId } : {}),
      phase: options.phase,
      worktree: options.workingDirectory,
      mutationFile: evidenceFile,
      beforeHead: error.before.head,
      afterHead: error.after.head,
      before: error.before.status || "clean",
      after: error.after.status || "clean",
      agentFailed: error.actionError !== undefined,
    }, options.runsRoot, options.stateFile);
    throw new AgentPhaseMutationError(error, options.phase, evidenceFile);
  }
}
