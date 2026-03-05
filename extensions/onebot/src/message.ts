type OneBotMessageSegment = {
  type?: string;
  data?: Record<string, unknown>;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCqAt(segment: string): string | null {
  const match = segment.match(/^\[CQ:at,([^\]]+)\]$/i);
  if (!match) return null;
  const kv = match[1] ?? "";
  const qqMatch = kv.match(/(?:^|,)qq=([^,\]]+)/i);
  if (!qqMatch) return null;
  return String(qqMatch[1] ?? "").trim() || null;
}

function formatAt(qq: string): string {
  return qq.toLowerCase() === "all" ? "@all" : `@${qq}`;
}

function stripCqCodes(input: string): string {
  // Keep @mentions readable; drop other CQ codes.
  return input
    .replace(/\[CQ:at,[^\]]+\]/gi, (seg) => {
      const qq = parseCqAt(seg);
      return qq ? formatAt(qq) : "";
    })
    .replace(/\[CQ:[^\]]+\]/gi, "")
    .replace(/\s+\n/g, "\n")
    .trim();
}

export function extractOneBotTextAndMentions(params: {
  message: unknown;
  selfId?: string | null;
}): { text: string; wasMentioned: boolean; hasAnyMention: boolean } {
  const selfId = params.selfId?.trim() || undefined;

  if (typeof params.message === "string") {
    const raw = params.message;
    const hasAnyMention = /\[CQ:at,[^\]]+\]/i.test(raw);
    const wasMentioned = selfId
      ? new RegExp(`\\[CQ:at,[^\\]]*qq=${escapeRegExp(selfId)}[^\\]]*\\]`, "i").test(raw)
      : false;
    return { text: stripCqCodes(raw), wasMentioned, hasAnyMention };
  }

  if (Array.isArray(params.message)) {
    const parts: string[] = [];
    let hasAnyMention = false;
    let wasMentioned = false;
    for (const entry of params.message) {
      const seg = entry as OneBotMessageSegment;
      const type = String(seg.type ?? "").trim().toLowerCase();
      const data = seg.data ?? {};
      if (type === "text") {
        const text = typeof data.text === "string" ? data.text : "";
        if (text) parts.push(text);
        continue;
      }
      if (type === "at") {
        const qq =
          typeof data.qq === "string" || typeof data.qq === "number" ? String(data.qq) : "";
        if (qq) {
          hasAnyMention = true;
          if (selfId && qq === selfId) wasMentioned = true;
          parts.push(formatAt(qq));
        }
        continue;
      }
    }
    return { text: parts.join("").trim(), wasMentioned, hasAnyMention };
  }

  return { text: "", wasMentioned: false, hasAnyMention: false };
}

export type NormalizedOneBotTarget =
  | { kind: "user"; id: string }
  | { kind: "group"; id: string };

export function normalizeOneBotTarget(raw: string): NormalizedOneBotTarget | undefined {
  let normalized = raw.trim();
  if (!normalized) return undefined;

  const lowered = normalized.toLowerCase();
  for (const prefix of ["onebot:", "qq:", "napcat:"]) {
    if (lowered.startsWith(prefix)) {
      normalized = normalized.slice(prefix.length).trim();
      break;
    }
  }

  const cleaned = normalized.replace(/^(to|chat):/i, "").trim();
  const userMatch = cleaned.match(/^(user|private|dm):(.+)$/i);
  if (userMatch) {
    const id = (userMatch[2] ?? "").trim();
    return id ? { kind: "user", id } : undefined;
  }
  const groupMatch = cleaned.match(/^group:(.+)$/i);
  if (groupMatch) {
    const id = (groupMatch[1] ?? "").trim();
    return id ? { kind: "group", id } : undefined;
  }
  return undefined;
}

