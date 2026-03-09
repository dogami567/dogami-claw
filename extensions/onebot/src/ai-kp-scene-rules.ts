type SceneRuleLike = {
  id?: string;
  actionKinds?: string[];
  match?: {
    targetNpc?: string[];
    targetClue?: string[];
    targetArea?: string[];
    skillKeys?: string[];
    itemNames?: string[];
    textIncludes?: string[];
  };
  defaults?: Record<string, unknown>;
};

export const ONEBOT_AIKP_SCENE_RULES: Record<string, SceneRuleLike[]> = {
  "old-church-night": [
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
        onSuccessPrompt:
          "你确实看出不对了。那不像自然磨出来的痕，更像是有人反复把什么细长东西塞进去又拔出来。祭坛下面多半有个能开的口子。",
      },
    },
    {
      id: "gravedigger-talk",
      actionKinds: ["talk"],
      match: {
        targetNpc: ["gravedigger", "守墓人"],
        textIncludes: ["守墓人", "钟声", "套话", "安抚"],
      },
      defaults: {
        skillKey: "Persuade",
        targetNpc: "gravedigger",
        leverageScore: 1,
        narrativeBonus: 1,
        riskLevel: "low",
        impactScore: 1,
        revealClueId: "clue-wall-symbol",
        mode: "open",
      },
    },
    {
      id: "wall-symbol-rubbing",
      actionKinds: ["use_item"],
      match: {
        targetClue: ["clue-wall-symbol", "墙上的旧符号", "符号"],
        itemNames: ["素描本", "sketchbook"],
        textIncludes: ["符号", "素描", "临", "画下来", "抄下来"],
      },
      defaults: {
        skillKey: "Psychology",
        itemName: "素描本",
        leverageScore: 1,
        narrativeBonus: 1,
        riskLevel: "medium",
        impactScore: 1,
        duration: "scene",
        revealClueId: "clue-wall-symbol",
        clueTitle: "重描后的旧符号轮廓",
        clueKind: "partial",
        clueQuality: "partial",
        mode: "open",
        onSuccessPrompt:
          "你把线条拆开一层层临下来后，终于看出来了：这不是一笔成形的符号，而是有人在旧痕上不断补写。",
      },
    },
    {
      id: "altar-board-pry",
      actionKinds: ["risky_action"],
      match: {
        targetArea: ["altar", "祭坛区", "祭坛"],
        textIncludes: ["木板", "掀", "撬", "强行打开"],
      },
      defaults: {
        skillKey: "Fighting",
        leverageScore: 1,
        riskLevel: "high",
        impactScore: 3,
        mode: "hidden",
        failureEventLabel: "祭坛下的脆响把教堂深处的东西惊醒了",
        onFailPrompt:
          "木板是掀开了，但那声脆响一下就在教堂里荡开了。你刚看见底下有一截黑布，右边走廊深处就先传来了一下拖擦声。",
      },
    },
    {
      id: "gravedigger-follow",
      actionKinds: ["follow"],
      match: {
        targetNpc: ["gravedigger", "守墓人"],
        textIncludes: ["跟", "尾随", "跟踪"],
      },
      defaults: {
        skillKey: "Stealth",
        targetNpc: "gravedigger",
        riskLevel: "medium",
        impactScore: 2,
        leverageScore: 1,
        routineHints: ["他傍晚会绕墓地和钟楼下巡一圈", "听见教堂异响时会先停一下，再提灯过去"],
      },
    },
  ],
  "bell-tower-followup": [
    {
      id: "stairs-listen",
      actionKinds: ["explore"],
      match: {
        targetArea: ["stairs", "旧木楼梯", "楼梯口"],
        skillKeys: ["Listen"],
        textIncludes: ["听", "listen", "动静"],
      },
      defaults: {
        skillKey: "Listen",
        leverageScore: 2,
        narrativeBonus: 1,
        riskLevel: "medium",
        impactScore: 2,
        revealClueId: "clue-tower-dust",
        clueTitle: "钟楼里残留的人为回响",
        clueKind: "optional",
        clueQuality: "clear",
        mode: "open",
        onSuccessPrompt:
          "你屏住气听了几秒，能分出来那不是风自己撞出来的响动。楼上确实留过人活动后的余波，而且还没散干净。",
      },
    },
    {
      id: "bell-rope-check",
      actionKinds: ["explore"],
      match: {
        targetClue: ["clue-bell-rope", "被动过的钟绳", "钟绳"],
        targetArea: ["bell-room", "钟室"],
        textIncludes: ["钟绳", "钟架"],
      },
      defaults: {
        skillKey: "Spot Hidden",
        leverageScore: 2,
        narrativeBonus: 1,
        riskLevel: "medium",
        impactScore: 2,
        revealClueId: "clue-bell-rope",
        clueTitle: "被动过的钟绳",
        clueKind: "core",
        clueQuality: "clear",
        mode: "open",
        onSuccessPrompt:
          "钟绳上那层灰断得很新，边缘还有被掌心反复压过的滑痕。昨晚来的人不是随便碰了一下，而是真的试过要把钟敲响。",
      },
    },
    {
      id: "bell-room-search",
      actionKinds: ["explore"],
      match: {
        targetClue: ["clue-tower-dust", "钟室角落的翻动痕迹", "翻动痕迹"],
        targetArea: ["bell-room", "钟室"],
        textIncludes: ["角落", "翻", "翻找", "搜"],
      },
      defaults: {
        skillKey: "Spot Hidden",
        leverageScore: 1,
        narrativeBonus: 1,
        riskLevel: "medium",
        impactScore: 1,
        revealClueId: "clue-tower-dust",
        clueTitle: "钟室角落的翻动痕迹",
        clueKind: "optional",
        clueQuality: "partial",
        mode: "open",
        onSuccessPrompt:
          "角落那堆灰不是自然塌的，像是有人蹲在这里翻过东西，翻完又匆匆拿鞋尖抹了两下。",
      },
    },
  ],
};
