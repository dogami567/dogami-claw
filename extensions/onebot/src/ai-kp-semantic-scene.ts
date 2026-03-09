import { ONEBOT_AIKP_SCENE_RULES } from "./ai-kp-scene-rules.js";

export const SCENE_ACTION_KINDS = [
  "explore",
  "talk",
  "use_item",
  "risky_action",
  "steal",
  "follow",
] as const;

export const SCENE_RISK_LEVELS = ["low", "medium", "high", "extreme"] as const;
export const SCENE_ACTION_MODES = ["open", "hidden"] as const;
export const SCENE_DURATIONS = ["instant", "1_round", "scene"] as const;

type AnyRecord = Record<string, any>;

export type SceneActionKind = (typeof SCENE_ACTION_KINDS)[number];
export type SceneRiskLevel = (typeof SCENE_RISK_LEVELS)[number];
export type SceneActionMode = (typeof SCENE_ACTION_MODES)[number];
export type SceneDuration = (typeof SCENE_DURATIONS)[number];

export type SemanticSceneIntent = {
  actionKind?: SceneActionKind;
  intentSummary?: string;
  normalizedAction?: string;
  skillKey?: string;
  targetNpc?: string;
  targetClue?: string;
  targetArea?: string;
  itemName?: string;
  riskLevel?: SceneRiskLevel;
  impactScore?: number;
  leverageScore?: number;
  narrativeBonus?: number;
  mode?: SceneActionMode;
  duration?: SceneDuration;
  revealClueId?: string;
  clueTitle?: string;
  clueKind?: string;
  clueQuality?: string;
  failureEventLabel?: string;
  onSuccessPrompt?: string;
  onFailPrompt?: string;
  routineHints?: string[];
  environmentTags?: string[];
};

type SemanticSceneDefaults = Partial<SemanticSceneIntent> & {
  targetNpc?: string;
  targetClue?: string;
  targetArea?: string;
};

type SemanticSceneRule = {
  id?: string;
  actionKinds?: SceneActionKind[];
  match?: {
    targetNpc?: string[];
    targetClue?: string[];
    targetArea?: string[];
    skillKeys?: string[];
    itemNames?: string[];
    textIncludes?: string[];
  };
  defaults?: SemanticSceneDefaults;
};

export type SemanticSceneActionBuildResult = {
  action?: AnyRecord;
  resolvedNpcId?: string | null;
  resolvedClueId?: string | null;
  resolvedAreaId?: string | null;
  matchedRuleId?: string | null;
  reason?: string | null;
};

function normalize(value: unknown): string {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim().toLowerCase();
  }
  return "";
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function clampInteger(value: number | undefined, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function uniqStrings(values: Array<string | undefined>): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = cleanText(value);
    if (!trimmed) continue;
    const key = normalize(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(trimmed);
  }
  return deduped;
}

function buildQueries(selectors: Array<string | undefined>): string[] {
  return uniqStrings(selectors).map((value) => normalize(value));
}

function includesQuery(candidate: string, query: string): boolean {
  return candidate === query || candidate.includes(query) || query.includes(candidate);
}

function selectorScore(ruleSelectors: string[] | undefined, selectors: Array<string | undefined>, sourceText: string): number {
  const ruleQueries = buildQueries(ruleSelectors ?? []);
  if (ruleQueries.length === 0) return 0;

  const incomingQueries = buildQueries(selectors);
  if (incomingQueries.length > 0) {
    for (const query of incomingQueries) {
      for (const candidate of ruleQueries) {
        if (candidate === query) return 3;
        if (includesQuery(candidate, query)) return 2;
      }
    }
    return -100;
  }

  if (sourceText && ruleQueries.some((candidate) => sourceText.includes(candidate))) {
    return 1;
  }
  return 0;
}

function findBestEntityMatch<T>(
  items: T[],
  selectors: Array<string | undefined>,
  getCandidates: (item: T) => Array<string | undefined>,
): T | null {
  const queries = buildQueries(selectors);
  if (queries.length === 0) return null;

  let partial: T | null = null;
  for (const item of items) {
    const candidates = uniqStrings(getCandidates(item)).map((value) => normalize(value));
    if (candidates.length === 0) continue;
    if (queries.some((query) => candidates.includes(query))) return item;
    if (!partial && queries.some((query) => candidates.some((candidate) => includesQuery(candidate, query)))) {
      partial = item;
    }
  }
  return partial;
}

function resolveSceneNpc(sessionState: AnyRecord, selectors: Array<string | undefined>): AnyRecord | null {
  const npcs = Array.isArray(sessionState.scene?.participants?.npcs) ? sessionState.scene.participants.npcs : [];
  return findBestEntityMatch(npcs, selectors, (npc: AnyRecord) => [npc.id, npc.name]);
}

function resolveSceneClue(sessionState: AnyRecord, selectors: Array<string | undefined>): AnyRecord | null {
  const clues = Array.isArray(sessionState.scene?.clues) ? sessionState.scene.clues : [];
  return findBestEntityMatch(clues, selectors, (clue: AnyRecord) => [clue.id, clue.title]);
}

function resolveSceneArea(sessionState: AnyRecord, selectors: Array<string | undefined>): AnyRecord | null {
  const areas = Array.isArray(sessionState.scene?.meta?.areas) ? sessionState.scene.meta.areas : [];
  return findBestEntityMatch(areas, selectors, (area: AnyRecord) => [
    area.id,
    area.name,
    area.description,
    ...(Array.isArray(area.notable) ? area.notable : []),
  ]);
}

function readSceneRules(sessionState: AnyRecord): SemanticSceneRule[] {
  const inlineRules = sessionState.scene?.meta?.semanticActions;
  if (Array.isArray(inlineRules) && inlineRules.length > 0) {
    return inlineRules as SemanticSceneRule[];
  }
  const scenarioId = cleanText(sessionState.scene?.meta?.scenarioId);
  if (!scenarioId) return [];
  return (ONEBOT_AIKP_SCENE_RULES[scenarioId] as SemanticSceneRule[] | undefined) ?? [];
}

function buildSourceText(originalText: string, intent: SemanticSceneIntent): string {
  return normalize(
    [
      originalText,
      intent.intentSummary,
      intent.normalizedAction,
      intent.targetNpc,
      intent.targetClue,
      intent.targetArea,
      intent.itemName,
    ].join(" "),
  );
}

function selectSceneRule(params: {
  rules: SemanticSceneRule[];
  intent: SemanticSceneIntent;
  sourceText: string;
}): SemanticSceneRule | null {
  let bestRule: SemanticSceneRule | null = null;
  let bestScore = 0;

  for (const rule of params.rules) {
    const actionKinds = Array.isArray(rule.actionKinds) ? rule.actionKinds : [];
    if (actionKinds.length > 0 && (!params.intent.actionKind || !actionKinds.includes(params.intent.actionKind))) {
      continue;
    }

    let score = actionKinds.length > 0 ? 4 : 0;
    score += selectorScore(rule.match?.targetNpc, [params.intent.targetNpc], params.sourceText);
    score += selectorScore(
      rule.match?.targetClue,
      [params.intent.targetClue, params.intent.revealClueId, params.intent.clueTitle],
      params.sourceText,
    );
    score += selectorScore(rule.match?.targetArea, [params.intent.targetArea], params.sourceText);
    score += selectorScore(rule.match?.skillKeys, [params.intent.skillKey], params.sourceText);
    score += selectorScore(rule.match?.itemNames, [params.intent.itemName], params.sourceText);
    score += selectorScore(rule.match?.textIncludes, [], params.sourceText);

    if (score <= 0 || score < bestScore) continue;
    bestScore = score;
    bestRule = rule;
  }

  return bestRule;
}

function buildGenericDefaults(intent: SemanticSceneIntent): SemanticSceneDefaults {
  switch (intent.actionKind) {
    case "talk":
      return {
        skillKey: "Persuade",
        riskLevel: "low",
        impactScore: 1,
        leverageScore: 1,
        narrativeBonus: 1,
        mode: "open",
      };
    case "use_item":
      return {
        riskLevel: "medium",
        impactScore: 1,
        leverageScore: 1,
        narrativeBonus: 1,
        duration: "scene",
        mode: "open",
      };
    case "risky_action":
      return {
        skillKey: "Fighting",
        riskLevel: "high",
        impactScore: 3,
        leverageScore: 1,
        mode: "hidden",
      };
    case "steal":
      return {
        skillKey: "Sleight of Hand",
        riskLevel: "high",
        impactScore: 2,
        leverageScore: 1,
        mode: "hidden",
      };
    case "follow":
      return {
        skillKey: "Stealth",
        riskLevel: "medium",
        impactScore: 2,
        leverageScore: 1,
        mode: "open",
      };
    case "explore":
    default:
      return {
        skillKey: "Spot Hidden",
        riskLevel: "medium",
        impactScore: 2,
        leverageScore: 1,
        narrativeBonus: 1,
        mode: "open",
      };
  }
}

export function buildSemanticSceneAction(params: {
  sessionState: AnyRecord;
  actorId: string;
  originalText: string;
  intent: SemanticSceneIntent;
}): SemanticSceneActionBuildResult {
  const { sessionState, actorId, originalText, intent } = params;
  if (!intent.actionKind) {
    return {
      reason: "missing_action_kind",
    };
  }

  const sourceText = buildSourceText(originalText, intent);
  const matchedRule = selectSceneRule({
    rules: readSceneRules(sessionState),
    intent,
    sourceText,
  });
  const ruleDefaults = matchedRule?.defaults ?? {};

  const npc = resolveSceneNpc(sessionState, [intent.targetNpc, ruleDefaults.targetNpc]);
  const clue = resolveSceneClue(sessionState, [
    intent.targetClue,
    intent.revealClueId,
    intent.clueTitle,
    ruleDefaults.targetClue,
    ruleDefaults.revealClueId,
    ruleDefaults.clueTitle,
  ]);
  const area = resolveSceneArea(sessionState, [intent.targetArea, ruleDefaults.targetArea]);
  const genericDefaults = buildGenericDefaults(intent);

  const environmentTags = uniqStrings([
    ...(intent.environmentTags ?? []),
    ...(ruleDefaults.environmentTags ?? []),
    area?.id ? `area:${area.id}` : undefined,
  ]);
  const routineHints = uniqStrings([...(intent.routineHints ?? []), ...(ruleDefaults.routineHints ?? [])]);

  return {
    action: {
      kind: intent.actionKind,
      actorId,
      intent: cleanText(intent.intentSummary) ?? cleanText(originalText) ?? intent.actionKind,
      skillKey: cleanText(intent.skillKey) ?? cleanText(ruleDefaults.skillKey) ?? cleanText(genericDefaults.skillKey),
      targetNpc:
        cleanText(npc?.id) ??
        cleanText(intent.targetNpc) ??
        cleanText(ruleDefaults.targetNpc),
      targetAreaId: cleanText(area?.id),
      targetAreaName: cleanText(area?.name),
      itemName: cleanText(intent.itemName) ?? cleanText(ruleDefaults.itemName),
      leverageScore:
        clampInteger(intent.leverageScore ?? ruleDefaults.leverageScore, 0, 3) ??
        clampInteger(genericDefaults.leverageScore, 0, 3),
      narrativeBonus:
        clampInteger(intent.narrativeBonus ?? ruleDefaults.narrativeBonus, 0, 2) ??
        clampInteger(genericDefaults.narrativeBonus, 0, 2),
      riskLevel: intent.riskLevel ?? ruleDefaults.riskLevel ?? genericDefaults.riskLevel,
      impactScore:
        clampInteger(intent.impactScore ?? ruleDefaults.impactScore, 1, 3) ??
        clampInteger(genericDefaults.impactScore, 1, 3),
      mode: intent.mode ?? ruleDefaults.mode ?? genericDefaults.mode,
      duration: intent.duration ?? ruleDefaults.duration ?? genericDefaults.duration,
      revealClueId:
        cleanText(intent.revealClueId) ??
        cleanText(clue?.id) ??
        cleanText(ruleDefaults.revealClueId),
      clueTitle:
        cleanText(intent.clueTitle) ??
        cleanText(clue?.title) ??
        cleanText(ruleDefaults.clueTitle),
      clueKind:
        cleanText(intent.clueKind) ??
        cleanText(clue?.kind) ??
        cleanText(ruleDefaults.clueKind),
      clueQuality:
        cleanText(intent.clueQuality) ??
        cleanText(clue?.quality) ??
        cleanText(ruleDefaults.clueQuality),
      failureEventLabel: cleanText(intent.failureEventLabel) ?? cleanText(ruleDefaults.failureEventLabel),
      onSuccessPrompt: cleanText(intent.onSuccessPrompt) ?? cleanText(ruleDefaults.onSuccessPrompt),
      onFailPrompt: cleanText(intent.onFailPrompt) ?? cleanText(ruleDefaults.onFailPrompt),
      routineHints: routineHints.length > 0 ? routineHints : undefined,
      environmentTags: environmentTags.length > 0 ? environmentTags : undefined,
    },
    resolvedNpcId: cleanText(npc?.id) ?? null,
    resolvedClueId:
      cleanText(clue?.id) ??
      cleanText(intent.revealClueId) ??
      cleanText(ruleDefaults.revealClueId) ??
      null,
    resolvedAreaId: cleanText(area?.id) ?? null,
    matchedRuleId: cleanText(matchedRule?.id) ?? null,
  };
}
