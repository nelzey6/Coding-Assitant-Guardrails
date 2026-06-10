import { spawnSync } from "child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

export interface MetricMap {
  [key: string]: number;
}

const METRIC_RE = /^METRIC\s+([\w.u]+)=([^\s]+)\s*$/gm;
const FORBIDDEN_METRIC_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseMetricLines(text: string): MetricMap {
  const metrics: MetricMap = {};
  for (const match of text.matchAll(METRIC_RE)) {
    const name = match[1];
    if (FORBIDDEN_METRIC_KEYS.has(name)) continue;
    const parsed = parseFloat(match[2]);
    if (!isNaN(parsed)) metrics[name] = parsed;
  }
  return metrics;
}

export function formatMetricsForPrompt(metrics: MetricMap): string {
  const keys = Object.keys(metrics);
  if (keys.length === 0) return "No structured METRIC lines were emitted.";
  return keys
    .sort()
    .map((k) => `METRIC ${k}=${metrics[k]}`)
    .join("\n");
}

function mergeMetrics(target: MetricMap, source: MetricMap): void {
  for (const [k, v] of Object.entries(source)) {
    target[k] = v;
  }
}

function runCommand(command: string, cwd: string, timeoutSeconds: number): string {
  const isWindows = process.platform === "win32";
  const id = randomBytes(8).toString("hex");

  if (isWindows) {
    const scriptPath = join(tmpdir(), `agentic-cmd-${id}.ps1`);
    // Append exit $LASTEXITCODE so PowerShell -File propagates the command's exit code.
    writeFileSync(scriptPath, `${command}\nexit $LASTEXITCODE`, "utf-8");
    try {
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { cwd, encoding: "utf-8", timeout: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined }
      );
      const text = ((result.stdout ?? "") + (result.stderr ?? "")).trimEnd();
      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          throw new Error(`Command timed out after ${timeoutSeconds} seconds: ${command}`);
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
  } else {
    const scriptPath = join(tmpdir(), `agentic-cmd-${id}.sh`);
    writeFileSync(scriptPath, command, "utf-8");
    try {
      const result = spawnSync(
        "sh",
        [scriptPath],
        { cwd, encoding: "utf-8", timeout: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined }
      );
      const text = ((result.stdout ?? "") + (result.stderr ?? "")).trimEnd();
      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          throw new Error(`Command timed out after ${timeoutSeconds} seconds: ${command}`);
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
}

export function invokeChecks(
  workingDirectory: string,
  checksToRun: string[],
  timeoutSeconds = 120
): string {
  const log: string[] = [];
  const allMetrics: MetricMap = {};
  const effectiveChecks = [...new Set(checksToRun.filter((c) => c && c.trim().length > 0))];

  if (effectiveChecks.length === 0) {
    return "No checks configured; agent exit success is the only external validation.\n\nStructured metrics:\nNo structured METRIC lines were emitted.";
  }

  for (const check of effectiveChecks) {
    console.log(`Running check in ${workingDirectory}: ${check}`);
    try {
      const output = runCommand(check, workingDirectory, timeoutSeconds);
      if (output) console.log(output);
      mergeMetrics(allMetrics, parseMetricLines(output));
      log.push(`PASS: ${check}`);
      if (output) log.push(output);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      mergeMetrics(allMetrics, parseMetricLines(msg));
      log.push(`FAIL: ${check}\n${msg}`);
      if (Object.keys(allMetrics).length > 0) {
        log.push(`Structured metrics:\n${formatMetricsForPrompt(allMetrics)}`);
      }
      throw new Error(log.join("\n"));
    }
  }

  log.push(`Structured metrics:\n${formatMetricsForPrompt(allMetrics)}`);
  return log.join("\n");
}
