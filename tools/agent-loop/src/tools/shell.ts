import { spawnSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

export interface ShellResult {
  stdout: string;
  stderr: string;
  combined: string;
  status: number | null;
  timedOut: boolean;
}

function isEtimeout(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ETIMEDOUT";
}

// On Windows, wrap a shell command in a PS1 script that propagates exit codes.
// The harness accepts common shell command strings from CLI/task JSON. Windows
// PowerShell 5 does not support bash/Pwsh-style `&&`, so translate the simple
// command-chaining form operators commonly pass for checks.
function normalizeWindowsPowerShellCommand(command: string): string {
  return command.replace(/\s+&&\s+/g, "; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; ");
}

function psScript(command: string): string {
  const normalized = normalizeWindowsPowerShellCommand(command);
  const trimmed = normalized.trimStart();
  const invocation = trimmed.startsWith('"') ? `& ${normalized}` : normalized;
  return `${invocation}\nexit $LASTEXITCODE`;
}

/**
 * Run a shell command string in a temporary script file.
 * Returns captured stdout+stderr combined; throws on timeout or non-zero exit.
 * Pass stdio:"inherit" to stream output to the terminal instead of capturing.
 */
export function runShellScript(
  command: string,
  cwd: string,
  timeoutMs: number | undefined,
  stdio: "inherit" | "pipe" = "pipe",
  env: NodeJS.ProcessEnv = process.env
): string {
  const isWindows = process.platform === "win32";
  const id = randomBytes(8).toString("hex");
  const scriptPath = isWindows
    ? join(tmpdir(), `agentic-${id}.ps1`)
    : join(tmpdir(), `agentic-${id}.sh`);

  writeFileSync(scriptPath, isWindows ? psScript(command) : command, "utf-8");

  try {
    const spawnOpts = { cwd, timeout: timeoutMs, encoding: "utf-8" as const, env };

    const result = isWindows
      ? spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
          stdio === "inherit" ? { ...spawnOpts, stdio: "inherit" as const } : spawnOpts)
      : spawnSync("sh", [scriptPath],
          stdio === "inherit" ? { ...spawnOpts, stdio: "inherit" as const } : spawnOpts);

    const text = stdio === "inherit"
      ? ""
      : (((result as { stdout?: string }).stdout ?? "") + ((result as { stderr?: string }).stderr ?? "")).trimEnd();

    if (result.error) {
      if (isEtimeout(result.error)) {
        const secs = timeoutMs != null ? timeoutMs / 1000 : "?";
        throw new Error(`Command timed out after ${secs}s: ${command}`);
      }
      throw new Error(`Command failed: ${command}\n${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`Command failed with code ${result.status}: ${command}\n${text}`);
    }
    return text;
  } finally {
    try { unlinkSync(scriptPath); } catch { /* ignore */ }
  }
}
