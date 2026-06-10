import { readFileSync, existsSync } from "fs";
import { join, relative } from "path";
import type { RepoContext, SkillEntry, BucketStructure } from "../context/index.js";
import { PROMOTABLE_BUCKETS, EXCLUDED_BUCKETS } from "../context/index.js";

export type Severity = "error" | "warning";

export interface Violation {
  severity: Severity;
  surface: "plugin.json" | "top-readme" | "bucket-readme" | "skill-md";
  skillName: string;
  bucket: string;
  message: string;
  expectedFix: string;
}

export interface ValidationResult {
  violations: Violation[];
  checkedSkills: number;
  passed: boolean;
}

// Extract skill paths from plugin.json entries like "./skills/engineering/foo"
function parsePluginSkillNames(pluginJsonPath: string): Set<string> {
  if (!existsSync(pluginJsonPath)) return new Set();
  const raw = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
  const skills: string[] = raw.skills ?? [];
  return new Set(
    skills.map((s: string) => {
      const parts = s.replace(/^\.\//, "").split("/");
      return parts[parts.length - 1]; // last segment is the skill name
    })
  );
}

// Extract markdown link targets from a file: [text](target)
function parseMarkdownLinks(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf-8");
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(text)) !== null) {
    links.push(match[2]);
  }
  return links;
}

// Check whether a README file contains a link to a skill's SKILL.md
function readmeLinksToSkillMd(readmePath: string, skillName: string): boolean {
  const links = parseMarkdownLinks(readmePath);
  return links.some((link) => {
    const normalized = link.replace(/\\/g, "/").toLowerCase();
    return (
      normalized.includes(`/${skillName.toLowerCase()}/skill.md`) ||
      normalized.endsWith(`/${skillName.toLowerCase()}/skill.md`)
    );
  });
}

// Check whether a README mentions a skill name at all (link text or path)
function readmeMentionsSkill(readmePath: string, skillName: string): boolean {
  if (!existsSync(readmePath)) return false;
  const text = readFileSync(readmePath, "utf-8").toLowerCase();
  return text.includes(skillName.toLowerCase());
}

export function runValidation(ctx: RepoContext): ValidationResult {
  const violations: Violation[] = [];

  const pluginSkillNames = parsePluginSkillNames(ctx.pluginJsonPath);

  const promotableSkills: SkillEntry[] = ctx.buckets
    .filter((b) => (PROMOTABLE_BUCKETS as readonly string[]).includes(b.bucket))
    .flatMap((b) => b.skills);

  const excludedSkills: SkillEntry[] = ctx.buckets
    .filter((b) => (EXCLUDED_BUCKETS as readonly string[]).includes(b.bucket))
    .flatMap((b) => b.skills);

  // --- Check each promotable skill ---
  for (const skill of promotableSkills) {
    // 1. Must appear in plugin.json
    if (!pluginSkillNames.has(skill.name)) {
      violations.push({
        severity: "error",
        surface: "plugin.json",
        skillName: skill.name,
        bucket: skill.bucket,
        message: `Skill "${skill.name}" (${skill.bucket}) is missing from .claude-plugin/plugin.json`,
        expectedFix: `Add "./skills/${skill.bucket}/${skill.name}" to the "skills" array in .claude-plugin/plugin.json`,
      });
    }

    // 2. Must appear in top-level README.md with a link to SKILL.md
    if (!ctx.topReadmeExists) {
      violations.push({
        severity: "error",
        surface: "top-readme",
        skillName: skill.name,
        bucket: skill.bucket,
        message: `README.md not found at repo root`,
        expectedFix: `Create README.md at the repo root`,
      });
    } else if (!readmeLinksToSkillMd(ctx.topReadmePath, skill.name)) {
      violations.push({
        severity: "error",
        surface: "top-readme",
        skillName: skill.name,
        bucket: skill.bucket,
        message: `Skill "${skill.name}" (${skill.bucket}) has no link to its SKILL.md in the top-level README.md`,
        expectedFix: `Add a markdown link to skills/${skill.bucket}/${skill.name}/SKILL.md in README.md`,
      });
    }

    // 3. Must appear in its bucket README.md with a link to SKILL.md
    const bucketData = ctx.buckets.find((b) => b.bucket === skill.bucket)!;
    if (!bucketData.readmeExists) {
      violations.push({
        severity: "error",
        surface: "bucket-readme",
        skillName: skill.name,
        bucket: skill.bucket,
        message: `Bucket README not found at skills/${skill.bucket}/README.md`,
        expectedFix: `Create skills/${skill.bucket}/README.md listing all skills in this bucket`,
      });
    } else if (!readmeLinksToSkillMd(bucketData.readmePath, skill.name)) {
      violations.push({
        severity: "error",
        surface: "bucket-readme",
        skillName: skill.name,
        bucket: skill.bucket,
        message: `Skill "${skill.name}" has no link to its SKILL.md in skills/${skill.bucket}/README.md`,
        expectedFix: `Add a markdown link to ./${skill.name}/SKILL.md in skills/${skill.bucket}/README.md`,
      });
    }

    // 4. Warn if SKILL.md is missing
    if (!skill.hasSkillMd) {
      violations.push({
        severity: "warning",
        surface: "skill-md",
        skillName: skill.name,
        bucket: skill.bucket,
        message: `Skill "${skill.name}" has no SKILL.md`,
        expectedFix: `Create skills/${skill.bucket}/${skill.name}/SKILL.md`,
      });
    }
  }

  // --- Check excluded skills do NOT appear in plugin.json or top-level README ---
  for (const skill of excludedSkills) {
    if (pluginSkillNames.has(skill.name)) {
      violations.push({
        severity: "error",
        surface: "plugin.json",
        skillName: skill.name,
        bucket: skill.bucket,
        message: `Skill "${skill.name}" (${skill.bucket}) must NOT appear in .claude-plugin/plugin.json`,
        expectedFix: `Remove "./skills/${skill.bucket}/${skill.name}" from .claude-plugin/plugin.json`,
      });
    }

    if (ctx.topReadmeExists && readmeMentionsSkill(ctx.topReadmePath, skill.name)) {
      violations.push({
        severity: "error",
        surface: "top-readme",
        skillName: skill.name,
        bucket: skill.bucket,
        message: `Skill "${skill.name}" (${skill.bucket}) must NOT appear in the top-level README.md`,
        expectedFix: `Remove all references to "${skill.name}" from README.md`,
      });
    }
  }

  const errors = violations.filter((v) => v.severity === "error");
  return {
    violations,
    checkedSkills: promotableSkills.length + excludedSkills.length,
    passed: errors.length === 0,
  };
}
