import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

export const PROMOTABLE_BUCKETS = ["engineering", "productivity", "misc"] as const;
export const EXCLUDED_BUCKETS = ["personal", "in-progress", "deprecated"] as const;
export type PromotableBucket = (typeof PROMOTABLE_BUCKETS)[number];
export type ExcludedBucket = (typeof EXCLUDED_BUCKETS)[number];
export type Bucket = PromotableBucket | ExcludedBucket;

export interface SkillEntry {
  name: string;
  bucket: Bucket;
  path: string; // absolute path to skill directory
  hasSkillMd: boolean;
}

export interface BucketStructure {
  bucket: Bucket;
  skills: SkillEntry[];
  readmePath: string;
  readmeExists: boolean;
}

export interface AgenticState {
  version?: number;
  goal?: string;
  phase?: string;
  maxIterations?: number;
  checks?: string[];
  tasks?: AgenticTask[];
  decisions?: string[];
  assumptions?: string[];
  openQuestions?: string[];
  blockers?: string[];
  promptPolicy?: { lessons?: string[] };
}

export interface ExecutionIntent {
  objective: string;
  steps: string[];
  currentStep?: string;
  branches?: string[];
  completionEvidence: string[];
  updatedAt: string;
}

export interface AgenticTask {
  id: string;
  title?: string;
  kind?: string;
  workflow?: string;
  status?: string;
  priority?: number;
  acceptanceCriteria?: string[];
  validation?: string[];
  dependsOn?: string[];
  scope?: string[];
  reviewBranch?: string;
  reviewWorktree?: string;
  failureHistory?: unknown[];
  artifacts?: unknown[];
  complexity?: "low" | "medium" | "high";
  complexityReasons?: string[];
  approvedStanceFile?: string;
  executionIntent?: ExecutionIntent;
}

export interface RepoContext {
  repoRoot: string;
  agentsText: string;
  agenticState: AgenticState | null;
  buckets: BucketStructure[];
  pluginJsonPath: string;
  pluginJsonExists: boolean;
  topReadmePath: string;
  topReadmeExists: boolean;
}

function readTextOrNull(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

function discoverSkillsInBucket(skillsRoot: string, bucket: Bucket): SkillEntry[] {
  const bucketPath = join(skillsRoot, bucket);
  if (!existsSync(bucketPath)) return [];

  return readdirSync(bucketPath)
    .filter((entry) => {
      const full = join(bucketPath, entry);
      return statSync(full).isDirectory() && entry !== "__pycache__";
    })
    .map((name) => {
      const skillPath = join(bucketPath, name);
      return {
        name,
        bucket,
        path: skillPath,
        hasSkillMd: existsSync(join(skillPath, "SKILL.md")),
      };
    });
}

export function loadContext(repoRoot: string): RepoContext {
  const root = resolve(repoRoot);
  const skillsRoot = join(root, "skills");

  const agentsText = readTextOrNull(join(root, "AGENTS.md")) ?? "";

  const agenticRaw = readTextOrNull(join(root, "agentic.json"));
  let agenticState: AgenticState | null = null;
  if (agenticRaw) {
    try { agenticState = JSON.parse(agenticRaw) as AgenticState; } catch { /* malformed — treat as missing */ }
  }

  const allBuckets: Bucket[] = [...PROMOTABLE_BUCKETS, ...EXCLUDED_BUCKETS];
  const buckets: BucketStructure[] = allBuckets.map((bucket) => {
    const readmePath = join(skillsRoot, bucket, "README.md");
    return {
      bucket,
      skills: discoverSkillsInBucket(skillsRoot, bucket),
      readmePath,
      readmeExists: existsSync(readmePath),
    };
  });

  const pluginJsonPath = join(root, ".claude-plugin", "plugin.json");
  const topReadmePath = join(root, "README.md");

  return {
    repoRoot: root,
    agentsText,
    agenticState,
    buckets,
    pluginJsonPath,
    pluginJsonExists: existsSync(pluginJsonPath),
    topReadmePath,
    topReadmeExists: existsSync(topReadmePath),
  };
}
