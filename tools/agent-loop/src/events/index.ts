import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

export interface AgenticEvent {
  ts: string;
  type: string;
  state?: string;
  task?: string;
  summary?: string;
  reason?: string;
  status?: string;
  [key: string]: unknown;
}

const FAILURE_TYPES = /failed|failure|needs_human|task_status/;

export function eventLogPath(runsRoot: string): string {
  return join(runsRoot, "events.jsonl");
}

export function loadEvents(repoRoot: string, runsRoot = ".agent-runs"): AgenticEvent[] {
  const logPath = eventLogPath(join(repoRoot, runsRoot));
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as AgenticEvent];
      } catch {
        return [];
      }
    });
}

// Append an event to events.jsonl, matching the PS1 Write-AgenticEvent shape:
// { ts, type, state, ...data } as one compact JSON line.
export function appendEvent(
  repoRoot: string,
  type: string,
  data: Record<string, unknown> = {},
  runsRoot = ".agent-runs",
  stateFile = "agentic.json"
): void {
  const logPath = eventLogPath(join(repoRoot, runsRoot));
  mkdirSync(dirname(logPath), { recursive: true });
  const entry = { ts: new Date().toISOString(), type, state: stateFile, ...data };
  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

export function getFailureEvents(events: AgenticEvent[], limit = 20): AgenticEvent[] {
  return events.filter((e) => FAILURE_TYPES.test(e.type)).slice(-limit);
}

export function getRecentEvents(events: AgenticEvent[], limit = 12): AgenticEvent[] {
  return events.slice(-limit);
}

export function formatEventLine(event: AgenticEvent): string {
  const taskPart = event.task ? ` [${event.task}]` : "";
  const detail =
    event.summary?.slice(0, 180) ??
    event.reason?.slice(0, 180) ??
    (event.status ? `status=${event.status}` : "");
  return `- ${event.type}${taskPart}${detail ? " " + detail : ""}`;
}
