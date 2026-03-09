import fs from "node:fs/promises";
import path from "node:path";

export type YunyingStage = {
  id: string;
  name: string;
  objective: string;
  actions: string[];
  completionCriteria: string[];
  failureStrategy?: string;
};

export type YunyingRisk = {
  id?: string;
  level?: string;
  rule: string;
  fallback?: string;
};

export type YunyingSkill = {
  id: string;
  name: string;
  platform: string;
  summary?: string;
  stages: YunyingStage[];
  risks: YunyingRisk[];
  defaults?: {
    phoneMode?: "direct" | "monitor";
    waitTimeoutMs?: number;
    repeatIntervalMs?: number;
    lang?: string;
    maxSteps?: number;
    maxRounds?: number;
    executorMaxSteps?: number;
    monitorUseScreenshot?: boolean;
  };
};

const PLATFORM_HINTS: Array<{ platform: string; hints: string[] }> = [
  { platform: "xiaohongshu", hints: ["小红书", "xhs"] },
  { platform: "dianping", hints: ["大众点评", "点评"] },
  { platform: "douyin", hints: ["抖音"] },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  if (items.length === 0) throw new Error(`${label} must include at least one string`);
  return items;
}

function parseStage(input: unknown, index: number): YunyingStage {
  if (!isRecord(input)) throw new Error(`stage[${index}] must be an object`);
  return {
    id: readRequiredString(input.id, `stage[${index}].id`),
    name: readRequiredString(input.name, `stage[${index}].name`),
    objective: readRequiredString(input.objective, `stage[${index}].objective`),
    actions: readStringArray(input.actions, `stage[${index}].actions`),
    completionCriteria: readStringArray(
      input.completionCriteria,
      `stage[${index}].completionCriteria`,
    ),
    failureStrategy: readOptionalString(input.failureStrategy),
  };
}

function parseRisk(input: unknown, index: number): YunyingRisk {
  if (!isRecord(input)) throw new Error(`risk[${index}] must be an object`);
  return {
    id: readOptionalString(input.id),
    level: readOptionalString(input.level),
    rule: readRequiredString(input.rule, `risk[${index}].rule`),
    fallback: readOptionalString(input.fallback),
  };
}

export function parseSkillDefinition(input: unknown): YunyingSkill {
  if (!isRecord(input)) throw new Error("skill must be an object");
  const rawDefaults = isRecord(input.defaults) ? input.defaults : undefined;

  return {
    id: readRequiredString(input.id, "skill.id"),
    name: readRequiredString(input.name, "skill.name"),
    platform: readRequiredString(input.platform, "skill.platform"),
    summary: readOptionalString(input.summary),
    stages: Array.isArray(input.stages)
      ? input.stages.map((stage, index) => parseStage(stage, index))
      : (() => {
          throw new Error("skill.stages must be an array");
        })(),
    risks: Array.isArray(input.risks) ? input.risks.map((risk, index) => parseRisk(risk, index)) : [],
    defaults: rawDefaults
      ? {
          phoneMode:
            rawDefaults.phoneMode === "direct" || rawDefaults.phoneMode === "monitor"
              ? rawDefaults.phoneMode
              : undefined,
          waitTimeoutMs:
            typeof rawDefaults.waitTimeoutMs === "number" ? rawDefaults.waitTimeoutMs : undefined,
          repeatIntervalMs:
            typeof rawDefaults.repeatIntervalMs === "number"
              ? rawDefaults.repeatIntervalMs
              : undefined,
          lang: readOptionalString(rawDefaults.lang),
          maxSteps: typeof rawDefaults.maxSteps === "number" ? rawDefaults.maxSteps : undefined,
          maxRounds: typeof rawDefaults.maxRounds === "number" ? rawDefaults.maxRounds : undefined,
          executorMaxSteps:
            typeof rawDefaults.executorMaxSteps === "number"
              ? rawDefaults.executorMaxSteps
              : undefined,
          monitorUseScreenshot:
            typeof rawDefaults.monitorUseScreenshot === "boolean"
              ? rawDefaults.monitorUseScreenshot
              : undefined,
        }
      : undefined,
  };
}

export async function loadSkillsFromDir(dir: string): Promise<YunyingSkill[]> {
  let entries: Array<{ name: string; isFile: () => boolean }> = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }

  const skills: YunyingSkill[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".skill.json")) continue;
    const filePath = path.join(dir, entry.name);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    skills.push(parseSkillDefinition(raw));
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export function inferPlatformFromGoal(goal?: string): string | undefined {
  const normalized = goal?.trim().toLowerCase();
  if (!normalized) return undefined;
  return PLATFORM_HINTS.find((item) =>
    item.hints.some((hint) => normalized.includes(hint.toLowerCase()))
  )?.platform;
}

export function buildStageTask(params: {
  skill: YunyingSkill;
  stage: YunyingStage;
  goal: string;
}): string {
  const riskRules = params.skill.risks.map((risk) => `${risk.level ?? "info"}:${risk.rule}`).join("；");
  return [
    "你正在执行一个手机运营阶段任务。",
    `平台：${params.skill.platform}`,
    `Skill：${params.skill.name}`,
    `全局目标：${params.goal}`,
    `当前阶段：${params.stage.name}`,
    `阶段目标：${params.stage.objective}`,
    `必须执行的动作：${params.stage.actions.join("；")}`,
    `完成判定：${params.stage.completionCriteria.join("；")}`,
    riskRules ? `风险约束：${riskRules}` : undefined,
    "只完成当前阶段；达到完成判定后立即停止并返回。",
  ]
    .filter(Boolean)
    .join("\n");
}
