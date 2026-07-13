import { spawn } from "child_process";
import { mkdirSync, readFileSync, appendFileSync, createWriteStream, writeFileSync, unlinkSync, existsSync, statSync } from "fs";
import { dirname, resolve, join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import type { Task as AgenticTask, AgenticState } from "../state/index.js";

export type AgentTool = "claude" | "pi" | "custom";

export interface AgentConfig {
  tool: AgentTool;
  /** Shell command template; must contain `{prompt}` which is replaced with the absolute prompt file path. */
  commandTemplate?: string;
  /** Seconds before the agent invocation is killed. 0 = no timeout. */
  timeoutSeconds?: number;
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}


/**
 * Run a shell command, streaming output live to stdout AND appending to logPath.
 * Resolves when the process exits; rejects on non-zero exit or spawn error.
 */
function spawnTee(command: string, cwd: string, timeoutSeconds: number, logPath: string, filterVerboseJson = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const id = randomBytes(8).toString("hex");
    const scriptPath = isWindows
      ? join(tmpdir(), `agentic-${id}.ps1`)
      : join(tmpdir(), `agentic-${id}.sh`);

    const script = isWindows
      ? `${command.trimStart().startsWith('"') ? `& ${command}` : command}\nexit $LASTEXITCODE`
      : command;
    writeFileSync(scriptPath, script, "utf-8");

    const logStream = createWriteStream(logPath, { flags: "a" });
    const child = isWindows
      ? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { cwd, stdio: ["ignore", "pipe", "pipe"] })
      : spawn("sh", [scriptPath], { cwd, stdio: ["ignore", "pipe", "pipe"] });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutSeconds > 0) {
      timer = setTimeout(() => {
        child.kill();
        reject(new AgentError(`Command timed out after ${timeoutSeconds}s: ${command}`));
      }, timeoutSeconds * 1000);
    }

    // Filter pi --mode json message_update events inline (97% of log volume).
    let lineBuf = "";
    const filterLine = filterVerboseJson
      ? ((line: string) => { try { const e = JSON.parse(line) as { type?: string }; return e.type !== "message_update"; } catch { return true; } })
      : undefined;

    const onData = (chunk: Buffer) => {
      if (!filterLine) { process.stdout.write(chunk); logStream.write(chunk); return; }
      lineBuf += chunk.toString("utf-8");
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (filterLine(line)) { const out = line + "\n"; process.stdout.write(out); logStream.write(out); }
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (err) => {
      clearTimeout(timer);
      logStream.end();
      try { unlinkSync(scriptPath); } catch { /* ignore */ }
      reject(new AgentError(`${err.message}: ${command}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (filterLine && lineBuf.length > 0 && filterLine(lineBuf)) { const out = lineBuf + "\n"; process.stdout.write(out); logStream.write(out); }
      logStream.end(() => {
        try { unlinkSync(scriptPath); } catch { /* ignore */ }
        if (code !== 0 && code !== null) {
          reject(new AgentError(`Command failed with code ${code}: ${command}`));
        } else {
          resolve();
        }
      });
    });
  });
}

export interface TokenUsage {
  tool: AgentTool | "custom";
  phase: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number | null;
}

export interface AgentInvocationResult {
  usage: TokenUsage | null;
  phase: string;
  tool: AgentTool | "custom";
  telemetryStatus: "complete" | "partial" | "unavailable";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  assistantTurns: number;
  toolCalls: number;
  logBytes: number;
}

function extractInvocationShape(logPath: string): { assistantTurns: number; toolCalls: number; logBytes: number } {
  if (!existsSync(logPath)) return { assistantTurns: 0, toolCalls: 0, logBytes: 0 };
  let assistantTurns = 0;
  let toolCalls = 0;
  try {
    for (const line of readFileSync(logPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: Array<{ type?: string }> } };
        if (event.type === "message_end" && event.message?.role === "assistant") {
          assistantTurns++;
          toolCalls += (event.message.content ?? []).filter((item) => item.type === "toolCall").length;
        }
      } catch { /* non-JSON agent output */ }
    }
    return { assistantTurns, toolCalls, logBytes: statSync(logPath).size };
  } catch {
    return { assistantTurns, toolCalls, logBytes: 0 };
  }
}

function extractClaudeUsage(logPath: string, phase: string): TokenUsage | null {
  if (!existsSync(logPath)) return null;
  const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const d = JSON.parse(line) as Record<string, unknown>;
      if (d.type === "result" && d.usage && typeof d.usage === "object") {
        const u = d.usage as Record<string, number>;
        return {
          tool: "claude",
          phase,
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          costUsd: typeof d.total_cost_usd === "number" ? d.total_cost_usd : null,
        };
      }
    } catch { /* skip non-JSON lines */ }
  }
  return null;
}

function extractPiUsage(logPath: string, phase: string): TokenUsage | null {
  if (!existsSync(logPath)) return null;
  const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const d = JSON.parse(line) as Record<string, unknown>;
      if (d.type === "agent_end" && Array.isArray(d.messages)) {
        const msgs = d.messages as Array<Record<string, unknown>>;
        const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
        const u = (lastAssistant?.usage ?? {}) as Record<string, unknown>;
        const cost = (u.cost ?? {}) as Record<string, number>;
        return {
          tool: "pi",
          phase,
          input: typeof u.input === "number" ? u.input : 0,
          output: typeof u.output === "number" ? u.output : 0,
          cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : 0,
          cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
          totalTokens: typeof u.totalTokens === "number" ? u.totalTokens : 0,
          costUsd: typeof cost.total === "number" && cost.total > 0 ? cost.total : null,
        };
      }
    } catch { /* skip non-JSON lines */ }
  }
  return null;
}

export function extractTokenUsage(logPath: string, tool: AgentTool | "custom", phase: string): TokenUsage | null {
  if (tool === "claude") return extractClaudeUsage(logPath, phase);
  if (tool === "pi") return extractPiUsage(logPath, phase);
  return null;
}

/**
 * Invoke an agent, streaming output live to stdout AND teeing to logPath.
 * On error, appends the error message to the log before re-throwing.
 * Returns token usage extracted from the log, or null if unavailable.
 */
export async function invokeAgentWithLog(
  promptFile: string,
  config: AgentConfig,
  workingDirectory: string,
  logPath: string,
  phase = "agent"
): Promise<AgentInvocationResult> {
  mkdirSync(dirname(logPath), { recursive: true });

  const timeout = config.timeoutSeconds ?? 0;
  const resolvedPrompt = resolve(promptFile);

  // Resolve which CLI the template targets, so we can pass the prompt file
  // correctly. pi and claude both treat a bare path as a literal prompt
  // string; they need `@<path>` to inline file contents.
  const detectToolFromTemplate = (template: string): AgentTool => {
    const t = template.trim();
    if (/(?:^|\s|[/\\])pi(?:\s|$)/.test(t)) return "pi";
    if (/(?:^|\s|[/\\])claude(?:\s|$)/.test(t)) return "claude";
    return "custom";
  };

  let command: string;
  let effectiveTool: AgentTool | "custom";
  if (config.commandTemplate) {
    const templateTool = detectToolFromTemplate(config.commandTemplate);
    const promptRef = templateTool === "custom" ? resolvedPrompt : `@${resolvedPrompt}`;
    command = config.commandTemplate.replace("{prompt}", promptRef);
    effectiveTool = templateTool;
  } else if (config.tool === "claude") {
    const prompt = readFileSync(promptFile, "utf-8").replace(/'/g, "'\\''");
    command = `claude -p '${prompt}' --output-format json`;
    effectiveTool = "claude";
  } else if (config.tool === "pi") {
    command = `pi -p "@${resolvedPrompt}" --mode json`;
    effectiveTool = "pi";
  } else {
    throw new AgentError(`--tool custom requires --command`);
  }

  const startedAt = new Date();
  const started = performance.now();
  try {
    await spawnTee(command, workingDirectory, timeout, logPath, effectiveTool === "pi");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendFileSync(logPath, `ERROR: ${msg}\n`, "utf-8");
    throw err;
  }

  const finishedAt = new Date();
  const usage = extractTokenUsage(logPath, effectiveTool, phase);
  const shape = extractInvocationShape(logPath);
  return {
    usage,
    phase,
    tool: effectiveTool,
    telemetryStatus: usage ? "complete" : "unavailable",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
    ...shape,
  };
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
