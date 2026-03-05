type OneBotApiEnvelope<T = unknown> = {
  status?: "ok" | "failed" | string;
  retcode?: number;
  data?: T;
  message?: string;
  msg?: string;
  wording?: string;
};

function joinOneBotUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  const normalized = path.replace(/^\/+/, "");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${normalized}`;
  return url.toString();
}

function resolveApiErrorMessage(envelope: OneBotApiEnvelope): string {
  const parts = [envelope.message, envelope.msg, envelope.wording]
    .map((v) => v?.trim())
    .filter(Boolean);
  if (parts.length > 0) return parts.join(" / ");
  return "OneBot request failed";
}

async function callOneBotApi<T>(params: {
  httpUrl: string;
  action: string;
  accessToken?: string;
  timeoutMs?: number;
  body?: Record<string, unknown>;
}): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = params.timeoutMs ?? 20_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(joinOneBotUrl(params.httpUrl, params.action), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(params.accessToken ? { authorization: `Bearer ${params.accessToken}` } : {}),
      },
      body: JSON.stringify(params.body ?? {}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OneBot HTTP ${res.status}: ${text || res.statusText}`.trim());
    }
    const envelope = (await res.json()) as OneBotApiEnvelope<T>;
    const status = String(envelope.status ?? "");
    const retcode = typeof envelope.retcode === "number" ? envelope.retcode : null;
    if ((status && status !== "ok") || (retcode !== null && retcode !== 0)) {
      const msg = resolveApiErrorMessage(envelope);
      throw new Error(`OneBot error: ${msg} (retcode=${retcode ?? "unknown"})`);
    }
    return (envelope.data ?? ({} as T)) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getOneBotLoginInfo(params: {
  httpUrl: string;
  accessToken?: string;
  timeoutMs?: number;
}): Promise<{ user_id?: number; nickname?: string }> {
  return await callOneBotApi({
    httpUrl: params.httpUrl,
    accessToken: params.accessToken,
    timeoutMs: params.timeoutMs,
    action: "get_login_info",
  });
}

export async function sendOneBotPrivateMessage(params: {
  httpUrl: string;
  accessToken?: string;
  timeoutMs?: number;
  userId: string;
  message: string;
}): Promise<{ message_id?: number }> {
  const userIdNum = Number.parseInt(params.userId, 10);
  return await callOneBotApi({
    httpUrl: params.httpUrl,
    accessToken: params.accessToken,
    timeoutMs: params.timeoutMs,
    action: "send_private_msg",
    body: {
      user_id: Number.isFinite(userIdNum) ? userIdNum : params.userId,
      message: params.message,
    },
  });
}

export async function sendOneBotGroupMessage(params: {
  httpUrl: string;
  accessToken?: string;
  timeoutMs?: number;
  groupId: string;
  message: string;
}): Promise<{ message_id?: number }> {
  const groupIdNum = Number.parseInt(params.groupId, 10);
  return await callOneBotApi({
    httpUrl: params.httpUrl,
    accessToken: params.accessToken,
    timeoutMs: params.timeoutMs,
    action: "send_group_msg",
    body: {
      group_id: Number.isFinite(groupIdNum) ? groupIdNum : params.groupId,
      message: params.message,
    },
  });
}

