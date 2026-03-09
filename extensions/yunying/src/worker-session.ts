const WORKER_SESSION_AGENT_ID = "yunying-worker";
const WORKER_SESSION_PREFIX = "worker";

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function buildWorkerSessionKey(deviceKey: string) {
  return `agent:${WORKER_SESSION_AGENT_ID}:${WORKER_SESSION_PREFIX}:${encodeURIComponent(deviceKey)}`;
}

export function resolveWorkerSessionKey(params: {
  deviceKey: string;
  workerSessionKey?: string;
}) {
  return readOptionalString(params.workerSessionKey) ?? buildWorkerSessionKey(params.deviceKey);
}
