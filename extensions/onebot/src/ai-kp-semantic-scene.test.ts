import { describe, expect, it } from "vitest";

import { buildSemanticSceneAction } from "./ai-kp-semantic-scene.js";

function buildSessionState(overrides: Record<string, unknown> = {}) {
  return {
    scene: {
      meta: {
        scenarioId: "old-church-night",
        areas: [
          { id: "altar", name: "祭坛区", description: "祭坛背后有异常刮痕", notable: ["异常刮痕"] },
          { id: "right-corridor", name: "右侧廊口", description: "守墓人常站这里", notable: ["守墓人"] },
        ],
        semanticActions: [
          {
            id: "altar-scratch-inspect",
            actionKinds: ["explore"],
            match: {
              targetArea: ["altar", "祭坛区", "祭坛"],
              targetClue: ["clue-altar-scratch", "祭坛背后的异常刮痕", "刮痕"],
              textIncludes: ["祭坛", "刮痕"],
            },
            defaults: {
              skillKey: "Spot Hidden",
              leverageScore: 2,
              narrativeBonus: 1,
              riskLevel: "medium",
              impactScore: 2,
              revealClueId: "clue-altar-scratch",
              clueTitle: "祭坛背后的异常刮痕",
              clueKind: "core",
              clueQuality: "clear",
              mode: "hidden",
            },
          },
          {
            id: "gravedigger-talk",
            actionKinds: ["talk"],
            match: {
              targetNpc: ["gravedigger", "守墓人"],
              textIncludes: ["守墓人", "钟声"],
            },
            defaults: {
              skillKey: "Persuade",
              targetNpc: "gravedigger",
              leverageScore: 1,
              narrativeBonus: 1,
              riskLevel: "low",
              impactScore: 1,
              revealClueId: "clue-wall-symbol",
            },
          },
          {
            id: "gravedigger-follow",
            actionKinds: ["follow"],
            match: {
              targetNpc: ["gravedigger", "守墓人"],
              textIncludes: ["跟", "尾随"],
            },
            defaults: {
              skillKey: "Stealth",
              targetNpc: "gravedigger",
              leverageScore: 1,
              riskLevel: "medium",
              impactScore: 2,
            },
          },
        ],
      },
      participants: {
        npcs: [{ id: "gravedigger", name: "守墓人" }],
      },
      clues: [
        { id: "clue-altar-scratch", title: "祭坛背后的异常刮痕", kind: "core", quality: "partial" },
        { id: "clue-wall-symbol", title: "墙上的旧符号", kind: "optional", quality: "partial" },
      ],
    },
    ...overrides,
  };
}

describe("buildSemanticSceneAction", () => {
  it("builds data-driven defaults from structured explore intent", () => {
    const result = buildSemanticSceneAction({
      sessionState: buildSessionState() as any,
      actorId: "dogami",
      originalText: "我借着手电去看祭坛背后的刮痕",
      intent: {
        actionKind: "explore",
        targetArea: "祭坛区",
        targetClue: "祭坛背后的异常刮痕",
      },
    });

    expect(result.action).toMatchObject({
      kind: "explore",
      actorId: "dogami",
      skillKey: "Spot Hidden",
      revealClueId: "clue-altar-scratch",
      mode: "hidden",
    });
    expect(result.matchedRuleId).toBe("altar-scratch-inspect");
    expect(result.resolvedAreaId).toBe("altar");
    expect(result.resolvedClueId).toBe("clue-altar-scratch");
  });

  it("maps talk/follow targets through scene rules instead of code branches", () => {
    const sessionState = buildSessionState();
    const talk = buildSemanticSceneAction({
      sessionState: sessionState as any,
      actorId: "dogami",
      originalText: "我想先稳住守墓人的情绪，再慢慢把话题带到昨晚的钟声",
      intent: {
        actionKind: "talk",
        targetNpc: "守墓人",
      },
    });
    expect(talk.action).toMatchObject({
      kind: "talk",
      targetNpc: "gravedigger",
      skillKey: "Persuade",
    });
    expect(talk.matchedRuleId).toBe("gravedigger-talk");

    const follow = buildSemanticSceneAction({
      sessionState: sessionState as any,
      actorId: "dogami",
      originalText: "等他转身以后我跟在后面，别让他发现",
      intent: {
        actionKind: "follow",
        targetNpc: "gravedigger",
      },
    });
    expect(follow.action).toMatchObject({
      kind: "follow",
      targetNpc: "gravedigger",
      skillKey: "Stealth",
    });
    expect(follow.matchedRuleId).toBe("gravedigger-follow");
  });

  it("falls back to tracked scene registry when runtime scene data has no inline semanticActions", () => {
    const sessionState = buildSessionState({
      scene: {
        meta: {
          scenarioId: "bell-tower-followup",
          areas: [{ id: "stairs", name: "旧木楼梯", description: "楼梯口", notable: ["动静"] }],
        },
        participants: { npcs: [] },
        clues: [{ id: "clue-tower-dust", title: "钟室角落的翻动痕迹", kind: "optional", quality: "partial" }],
      },
    });

    const result = buildSemanticSceneAction({
      sessionState: sessionState as any,
      actorId: "dogami",
      originalText: "我先停在楼梯口听听上面的动静",
      intent: {
        actionKind: "explore",
        targetArea: "旧木楼梯",
        skillKey: "Listen",
      },
    });

    expect(result.action).toMatchObject({
      kind: "explore",
      skillKey: "Listen",
      revealClueId: "clue-tower-dust",
    });
    expect(result.matchedRuleId).toBe("stairs-listen");
  });
});
