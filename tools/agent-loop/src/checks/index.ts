import { runShellScript } from "../tools/shell.js";

export interface MetricMap {
  [key: string]: number;
}

const METRIC_RE = /^METRIC\s+([\w.u]+)=([^\s]+)\s*$/gm;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 120;

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
  return runShellScript(command, cwd, timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined, "pipe");
}

export function invokeChecks(
  workingDirectory: string,
  checksToRun: string[],
  timeoutSeconds = DEFAULT_CHECK_TIMEOUT_SECONDS
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
