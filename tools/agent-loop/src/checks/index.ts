import { createHash } from "crypto";
import { captureCheckoutSnapshot, git } from "../tools/index.js";
import type { CheckDefinition, CheckBatch, ReviewEvidence, Task } from "../state/index.js";
import { runShellScript, validateShellSyntax } from "../tools/shell.js";
import { existsSync, readFileSync } from "fs";
import { join, isAbsolute } from "path";

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

function parseEnvFile(path: string): NodeJS.ProcessEnv {
  if (!existsSync(path)) return {};
  const env: NodeJS.ProcessEnv = {};
  for (const rawLine of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    env[key] = value;
  }
  return env;
}

function runCommand(command: string, cwd: string, timeoutSeconds: number, env: NodeJS.ProcessEnv): string {
  return runShellScript(command, cwd, timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined, "pipe", env);
}

/** Resolve once before execution; operator checks cannot be displaced by proposals. */
export function resolveChecks(cwd: string, state: string[] = [], task: string[] = [], operator: string[] = []): CheckDefinition[] {
  const checks = new Map<string, CheckDefinition>();
  for (const [source, commands] of [["operator", operator], ["state", state], ["task", task]] as const) {
    for (const raw of commands) {
      const command = raw.trim();
      if (!command) continue;
      const existing = checks.get(command);
      if (existing) { if (!existing.sources.includes(source)) existing.sources.push(source); }
      else checks.set(command, { id: `check-${digest([cwd, command])}`, command, cwd, sources: [source] });
    }
  }
  return [...checks.values()];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

export function runChecks(cwd: string, definitions: CheckDefinition[], timeoutSeconds = DEFAULT_CHECK_TIMEOUT_SECONDS, envFile = ""): CheckBatch {
  const snapshot = captureCheckoutSnapshot(cwd);
  const candidate = { head: snapshot.head, fingerprint: snapshot.fingerprint };
  const batch: CheckBatch = { candidate, results: [], log: "" };
  const envPath = envFile ? (isAbsolute(envFile) ? envFile : join(cwd, envFile)) : "";
  const env = envPath ? { ...process.env, ...parseEnvFile(envPath) } : process.env;
  const metrics: MetricMap = {};
  for (const check of definitions) {
    const start = Date.now();
    let output = "";
    let status: "passed" | "failed" | "invalid" = "passed";
    try {
      const syntaxError = validateShellSyntax(check.command);
      if (syntaxError) { status = "invalid"; batch.failureKind = "configuration"; output = syntaxError; }
      else {
        console.log(`Running check in ${check.cwd}: ${check.command}`);
        output = runCommand(check.command, check.cwd, timeoutSeconds, env);
        if (output) console.log(output);
      }
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
      status = "failed";
      batch.failureKind = /timed out|ENOENT|failed with code (?:126|127)\b/.test(output) ? "environment" : "code";
    }
    mergeMetrics(metrics, parseMetricLines(output));
    const after = captureCheckoutSnapshot(cwd);
    if (after.head !== candidate.head || after.fingerprint !== candidate.fingerprint) {
      status = "failed"; batch.failureKind = "candidate_mutation";
      output += "\nCheck changed the candidate; evidence invalidated.";
      for (const result of batch.results) delete result.evidenceId;
    }
    batch.results.push({ ...check, status, output, durationMs: Date.now() - start,
      ...(status === "passed" ? { evidenceId: `passed-${digest([candidate, check])}` } : {}) });
    if (batch.failureKind) break;
  }
  batch.log = batch.results.map((r) => `${r.status === "passed" ? "PASS" : "FAIL"}: ${r.command}${r.output ? `\n${r.output}` : ""}`).join("\n")
    + `\nStructured metrics:\n${formatMetricsForPrompt(metrics)}`;
  return batch;
}

export function buildReviewEvidence(task: Task, batch: CheckBatch, cwd: string): ReviewEvidence {
  const current = captureCheckoutSnapshot(cwd);
  if (batch.failureKind || current.head !== batch.candidate.head || current.fingerprint !== batch.candidate.fingerprint) throw new Error("Candidate no longer matches passed check evidence");
  const files = git(["diff", "HEAD", "--name-only"], cwd).split("\n").filter(Boolean);
  return {
    candidate: batch.candidate,
    requirements: (task.acceptanceCriteria ?? []).map((text, index) => ({ id: `criterion-${digest([task.id, index, text])}`, text })),
    checks: batch.results,
    diff: { id: `diff-${digest(batch.candidate)}`, files, hasCode: files.some((file) => !/\.md$/i.test(file)) },
  };
}

/** Reject empty or diagnostic-only proof. Semantic relevance is judged by the verifier. */
export function validateAcceptanceChecks(checks: string[]): string[] {
  const hasAssertion = checks.some((raw) => {
    const command = raw.trim();
    if (!command || /^(?:true|:|exit\s+0)\s*;?$/.test(command)) return false;
    if (/^(?:echo|printf)\b/.test(command) && !/[;&|]/.test(command)) return false;
    if (/^git\s+(?:diff|status|log|show)\b/.test(command) && !/[;&|]/.test(command)) return false;
    if (/^node\s+-e\s+['"]\s*process\.exit\(0\);?\s*['"]$/.test(command)) return false;
    return true;
  });
  return hasAssertion ? [] : ["Acceptance requires a focused assertion/test; empty or diagnostic-only commands do not prove completion"];
}
