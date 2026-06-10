import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, appendFileSync, createWriteStream } from "fs";
import { dirname, resolve } from "path";
import type { AgenticTask, AgenticState } from "../context/index.js";

export type AgentTool = "claude" | "pi" | "custom";

export interface AgentConfig {
  tool: AgentTool;
  /** Shell command template; must contain `{prompt}` which is replaced with the absolute prompt file path. */
  commandTemplate?: string;
  /** Shell command template for the verifier agent (falls back to commandTemplate if absent). */
  verifierCommandTemplate?: string;
  /** Seconds before the agent invocation is killed. 0 = no timeout. */
  timeoutSeconds?: number;
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

function shellRun(command: string, cwd: string, timeoutSeconds: number): void {
  const isWindows = process.platform === "win32";
  const opts = {
    cwd,
    stdio: "inherit" as const,
    timeout: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
    shell: false as const,
  };

  const result = isWindows
    ? spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], opts)
    : spawnSync("sh", ["-lc", command], opts);

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") throw new AgentError(`Agent timed out after ${timeoutSeconds}s: ${command}`);
    throw new AgentError(`Agent failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new AgentError(`Agent exited with code ${result.status}: ${command}`);
  }
}

function shellCapture(command: string, cwd: string, timeoutSeconds: number): string {
  const isWindows = process.platform === "win32";
  const opts = {
    cwd,
    encoding: "utf-8" as const,
    timeout: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
    shell: false as const,
  };

  const result = isWindows
    ? spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], opts)
    : spawnSync("sh", ["-lc", command], opts);

  const text = ((result.stdout ?? "") + (result.stderr ?? "")).trimEnd();
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") throw new AgentError(`Agent timed out after ${timeoutSeconds}s: ${command}`);
    throw new AgentError(`Agent failed: ${result.error.message}\n${text}`);
  }
  if (result.status !== 0) {
    throw new AgentError(`Agent exited with code ${result.status}: ${command}\n${text}`);
  }
  return text;
}

/**
 * Invoke an agent with the given prompt file.
 * When config.commandTemplate is set, substitutes `{prompt}` with the resolved
 * prompt path and runs it via the shell (mirroring `Invoke-Agent` with --command).
 * Otherwise dispatches to the named tool ("claude" or "pi").
 * Output goes directly to stdout/stderr (no capture).
 */
export function invokeAgent(
  promptFile: string,
  config: AgentConfig,
  workingDirectory = process.cwd()
): void {
  const template = config.commandTemplate;
  const timeout = config.timeoutSeconds ?? 0;

  if (template) {
    const resolvedPrompt = resolve(promptFile);
    const command = template.replace("{prompt}", resolvedPrompt);
    if (timeout > 0) {
      // capture so the loop can inspect output; print it too
      const out = shellCapture(command, workingDirectory, timeout);
      if (out) process.stdout.write(out + "\n");
    } else {
      shellRun(command, workingDirectory, 0);
    }
    return;
  }

  switch (config.tool) {
    case "claude": {
      const prompt = readFileSync(promptFile, "utf-8");
      const result = spawnSync("claude", ["-p", prompt], {
        cwd: workingDirectory,
        stdio: "inherit",
        timeout: timeout > 0 ? timeout * 1000 : undefined,
      });
      if (result.error) throw new AgentError(`claude failed: ${result.error.message}`);
      if (result.status !== 0) throw new AgentError(`claude exited with code ${result.status}`);
      break;
    }
    case "pi": {
      const resolvedPrompt = resolve(promptFile);
      const result = spawnSync("pi", ["-p", `@${resolvedPrompt}`], {
        cwd: workingDirectory,
        stdio: "inherit",
        timeout: timeout > 0 ? timeout * 1000 : undefined,
      });
      if (result.error) throw new AgentError(`pi failed: ${result.error.message}`);
      // pi does not always set exit code reliably; only throw on definite non-zero
      if (typeof result.status === "number" && result.status !== 0) {
        throw new AgentError(`pi exited with code ${result.status}`);
      }
      break;
    }
    case "custom":
      throw new AgentError("--tool custom requires --command '... {prompt} ...'");
    default:
      throw new AgentError(`Unknown tool '${config.tool}'. Use --command for custom CLIs.`);
  }
}

/**
 * Invoke an agent and tee all output to logPath.
 * On error, appends the error message to the log before re-throwing.
 */
export function invokeAgentWithLog(
  promptFile: string,
  config: AgentConfig,
  workingDirectory: string,
  logPath: string
): void {
  mkdirSync(dirname(logPath), { recursive: true });

  // For the log, we need captured output. Re-run with capture mode.
  const template = config.commandTemplate;
  const timeout = config.timeoutSeconds ?? 0;

  if (template) {
    const resolvedPrompt = resolve(promptFile);
    const command = template.replace("{prompt}", resolvedPrompt);
    try {
      const out = shellCapture(command, workingDirectory, timeout);
      if (out) {
        process.stdout.write(out + "\n");
        appendFileSync(logPath, out + "\n", "utf-8");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendFileSync(logPath, `ERROR: ${msg}\n`, "utf-8");
      throw err;
    }
    return;
  }

  // For named tools (claude/pi) we can only capture via a spawned wrapper;
  // use the same shellCapture path by composing the command string.
  const isWindows = process.platform === "win32";
  const resolvedPrompt = resolve(promptFile);
  let command: string;
  if (config.tool === "claude") {
    const prompt = readFileSync(promptFile, "utf-8").replace(/'/g, "'\\''");
    command = `claude -p '${prompt}'`;
  } else if (config.tool === "pi") {
    command = isWindows ? `pi -p "@${resolvedPrompt}"` : `pi -p "@${resolvedPrompt}"`;
  } else {
    throw new AgentError(`--tool custom requires --command`);
  }

  try {
    const out = shellCapture(command, workingDirectory, timeout);
    if (out) {
      process.stdout.write(out + "\n");
      appendFileSync(logPath, out + "\n", "utf-8");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendFileSync(logPath, `ERROR: ${msg}\n`, "utf-8");
    throw err;
  }
}

/**
 * Merge state-level checks with the task's own validation commands,
 * deduplicating and stripping blanks — mirrors Get-TaskChecks in the PS1.
 */
export function getTaskChecks(task: AgenticTask, state: AgenticState): string[] {
  const stateChecks: string[] = (state.checks ?? []).filter((c) => c && c.trim().length > 0);
  const taskChecks: string[] = (task.validation ?? []).filter((c) => c && c.trim().length > 0);
  return [...new Set([...stateChecks, ...taskChecks])];
}
