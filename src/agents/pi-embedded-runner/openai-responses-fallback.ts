import type { StreamFn } from "@mariozechner/pi-agent-core";
import { calculateCost, getEnvApiKey, streamSimple, supportsXhigh } from "@mariozechner/pi-ai";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
  Tool,
  Usage,
} from "@mariozechner/pi-ai";
import { transformMessages } from "@mariozechner/pi-ai/dist/providers/transform-messages.js";
import { sanitizeSurrogates } from "@mariozechner/pi-ai/dist/utils/sanitize-unicode.js";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai/dist/utils/event-stream.js";

type OpenAIResponsesStreamOptions = SimpleStreamOptions & {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  serviceTier?: string;
};

type ResponseStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "in_progress"
  | "incomplete"
  | "queued";

type ResponseUsageShape = {
  input_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens?: number;
  total_tokens?: number;
};

type ResponseOutputTextShape = {
  annotations?: unknown[];
  text?: string;
  type?: string;
};

type ResponseOutputRefusalShape = {
  refusal?: string;
  type?: string;
};

type ResponseOutputMessageShape = {
  id?: string;
  content?: Array<ResponseOutputTextShape | ResponseOutputRefusalShape>;
  type?: "message";
};

type ResponseReasoningSummaryShape = {
  text?: string;
  type?: string;
};

type ResponseReasoningContentShape = {
  text?: string;
  type?: string;
};

type ResponseReasoningItemShape = {
  content?: ResponseReasoningContentShape[];
  encrypted_content?: string | null;
  id?: string;
  summary?: ResponseReasoningSummaryShape[];
  type?: "reasoning";
};

type ResponseFunctionCallShape = {
  arguments?: string;
  call_id?: string;
  id?: string;
  name?: string;
  type?: "function_call";
};

type ResponseShape = {
  output?: Array<
    ResponseOutputMessageShape | ResponseReasoningItemShape | ResponseFunctionCallShape
  >;
  service_tier?: string;
  status?: ResponseStatus;
  usage?: ResponseUsageShape;
};

function createBaseUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createBaseAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createBaseUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function shouldUseNonStreamingResponses(model: Model<Api>): boolean {
  return model.api === "openai-responses" && model.provider === "gmn";
}

function shortHash(value: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;

  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    first = Math.imul(first ^ codePoint, 2654435761);
    second = Math.imul(second ^ codePoint, 1597334677);
  }

  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);

  return `${(second >>> 0).toString(36)}${(first >>> 0).toString(36)}`;
}

function normalizeToolCallId(id: string, model: Model<"openai-responses">): string {
  const allowedProviders = new Set(["openai", "openai-codex", "opencode"]);
  if (!allowedProviders.has(model.provider) || !id.includes("|")) return id;

  const [callId, itemId] = id.split("|");
  const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
  let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!sanitizedItemId.startsWith("fc")) {
    sanitizedItemId = `fc_${sanitizedItemId}`;
  }

  const normalizedCallId =
    sanitizedCallId.length > 64 ? sanitizedCallId.slice(0, 64) : sanitizedCallId;
  const normalizedItemId =
    sanitizedItemId.length > 64 ? sanitizedItemId.slice(0, 64) : sanitizedItemId;
  return `${normalizedCallId}|${normalizedItemId}`;
}

function convertMessages(model: Model<"openai-responses">, context: Context) {
  const items: Array<Record<string, unknown>> = [];
  const transformedMessages = transformMessages(context.messages, model, (id) =>
    normalizeToolCallId(id, model),
  );

  if (context.systemPrompt) {
    items.push({
      role: model.reasoning ? "developer" : "system",
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let messageIndex = 0;

  for (const message of transformedMessages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        items.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeSurrogates(message.content) }],
        });
        messageIndex += 1;
        continue;
      }

      const content = message.content
        .map((item) =>
          item.type === "text"
            ? {
                type: "input_text",
                text: sanitizeSurrogates(item.text),
              }
            : {
                type: "input_image",
                detail: "auto",
                image_url: `data:${item.mimeType};base64,${item.data}`,
              },
        )
        .filter((item) => model.input.includes("image") || item.type !== "input_image");

      if (content.length > 0) {
        items.push({
          role: "user",
          content,
        });
      }
      messageIndex += 1;
      continue;
    }

    if (message.role === "assistant") {
      const assistantItems: Array<Record<string, unknown>> = [];
      const isDifferentModel =
        message.model !== model.id &&
        message.provider === model.provider &&
        message.api === model.api;

      for (const block of message.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            assistantItems.push(JSON.parse(block.thinkingSignature) as Record<string, unknown>);
          }
          continue;
        }

        if (block.type === "text") {
          let messageId = block.textSignature;
          if (!messageId) {
            messageId = `msg_${messageIndex}`;
          } else if (messageId.length > 64) {
            messageId = `msg_${shortHash(messageId)}`;
          }

          assistantItems.push({
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: sanitizeSurrogates(block.text),
                annotations: [],
              },
            ],
            status: "completed",
            id: messageId,
          });
          continue;
        }

        if (block.type === "toolCall") {
          const [callId, rawItemId] = block.id.split("|");
          const itemId =
            isDifferentModel && rawItemId?.startsWith("fc_") ? undefined : (rawItemId ?? undefined);

          assistantItems.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          });
        }
      }

      if (assistantItems.length > 0) {
        items.push(...assistantItems);
      }

      messageIndex += 1;
      continue;
    }

    if (message.role === "toolResult") {
      const textResult = message.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const hasImages = message.content.some((item) => item.type === "image");
      const hasText = textResult.length > 0;

      items.push({
        type: "function_call_output",
        call_id: message.toolCallId.split("|")[0],
        output: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
      });

      if (hasImages && model.input.includes("image")) {
        const content: Array<Record<string, string>> = [
          {
            type: "input_text",
            text: "Attached image(s) from tool result:",
          },
        ];

        for (const block of message.content) {
          if (block.type !== "image") continue;
          content.push({
            type: "input_image",
            detail: "auto",
            image_url: `data:${block.mimeType};base64,${block.data}`,
          });
        }

        items.push({
          role: "user",
          content,
        });
      }

      messageIndex += 1;
    }
  }

  return items;
}

function convertTools(tools: Tool[] | undefined) {
  return tools?.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

function clampReasoning(
  effort: OpenAIResponsesStreamOptions["reasoning"],
): OpenAIResponsesStreamOptions["reasoningEffort"] {
  return effort === "xhigh" ? "high" : effort;
}

function resolveRequestOptions(
  model: Model<"openai-responses">,
  options: OpenAIResponsesStreamOptions | undefined,
) {
  return {
    temperature: options?.temperature,
    maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32_000),
    signal: options?.signal,
    apiKey: options?.apiKey || getEnvApiKey(model.provider),
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    reasoningEffort:
      options?.reasoningEffort ??
      (supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning)),
    reasoningSummary: options?.reasoningSummary,
    serviceTier: options?.serviceTier,
  };
}

function buildRequestPayload(
  model: Model<"openai-responses">,
  context: Context,
  options: ReturnType<typeof resolveRequestOptions>,
) {
  const input = convertMessages(model, context);
  const payload: Record<string, unknown> = {
    model: model.id,
    input,
    stream: false,
    prompt_cache_key: options.sessionId,
  };

  if (options.maxTokens) {
    payload.max_output_tokens = options.maxTokens;
  }
  if (options.temperature !== undefined) {
    payload.temperature = options.temperature;
  }
  if (options.serviceTier !== undefined) {
    payload.service_tier = options.serviceTier;
  }

  const tools = convertTools(context.tools);
  if (tools?.length) {
    payload.tools = tools;
  }

  if (model.reasoning) {
    if (options.reasoningEffort || options.reasoningSummary) {
      payload.reasoning = {
        effort: options.reasoningEffort || "medium",
        summary: options.reasoningSummary || "auto",
      };
      payload.include = ["reasoning.encrypted_content"];
    } else if (model.name.startsWith("gpt-5")) {
      input.push({
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "# Juice: 0 !important",
          },
        ],
      });
    }
  }

  return payload;
}

function resolveHeaders(
  model: Model<"openai-responses">,
  apiKey: string,
  headers: Record<string, string> | undefined,
) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...model.headers,
    ...headers,
  };
}

function tryParseResponseShape(raw: string): ResponseShape | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as ResponseShape;
}

function tryParseResponseShapeFromSse(raw: string): ResponseShape | null {
  let latest: ResponseShape | null = null;
  const blocks = raw.split(/\r?\n\r?\n/);

  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;

    const dataText = dataLines.join("\n");
    if (!dataText || dataText === "[DONE]") continue;

    try {
      const parsed = JSON.parse(dataText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const response =
        "response" in record &&
        record.response &&
        typeof record.response === "object" &&
        !Array.isArray(record.response)
          ? (record.response as ResponseShape)
          : null;
      if (response) {
        latest = response;
        continue;
      }
      latest = record as ResponseShape;
    } catch {
      continue;
    }
  }

  return latest;
}

function parseResponseBody(raw: string): ResponseShape {
  try {
    const parsed = tryParseResponseShape(raw);
    if (parsed) return parsed;
  } catch {
    // Fall back to SSE parsing below.
  }

  const parsedFromSse = tryParseResponseShapeFromSse(raw);
  if (parsedFromSse) return parsedFromSse;

  const preview = raw.trim().slice(0, 120);
  throw new Error(
    preview
      ? `Unable to parse OpenAI Responses payload: ${preview}`
      : "Empty OpenAI Responses payload",
  );
}

async function createResponse(
  model: Model<"openai-responses">,
  context: Context,
  options: ReturnType<typeof resolveRequestOptions>,
): Promise<ResponseShape> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const payload = buildRequestPayload(model, context, options);
  options.onPayload?.(payload);

  const url = `${model.baseUrl.replace(/\/+$/, "")}/responses`;
  const response = await fetch(url, {
    method: "POST",
    headers: resolveHeaders(model, apiKey, options.headers),
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(bodyText || `HTTP ${response.status}`);
  }

  return parseResponseBody(await response.text());
}

function getServiceTierCostMultiplier(serviceTier: string | undefined): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(usage: Usage, serviceTier: string | undefined) {
  const multiplier = getServiceTierCostMultiplier(serviceTier);
  if (multiplier === 1) return;
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function mapStopReason(status: ResponseStatus | undefined): StopReason {
  if (!status) return "stop";

  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default:
      return "stop";
  }
}

function extractMessageText(item: ResponseOutputMessageShape): string {
  return (item.content ?? [])
    .map((contentPart) =>
      contentPart.type === "output_text"
        ? "text" in contentPart
          ? (contentPart.text ?? "")
          : ""
        : contentPart.type === "refusal"
          ? "refusal" in contentPart
            ? (contentPart.refusal ?? "")
            : ""
          : "",
    )
    .join("");
}

function extractReasoningText(item: ResponseReasoningItemShape): string {
  const summary = (item.summary ?? [])
    .filter((part) => part.type === "summary_text")
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n\n");
  if (summary) return summary;

  return (item.content ?? [])
    .filter((part) => part.type === "reasoning_text")
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n\n");
}

function parseJsonArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function populateAssistantMessage(
  model: Model<"openai-responses">,
  output: AssistantMessage,
  response: ResponseShape,
  options: ReturnType<typeof resolveRequestOptions>,
) {
  for (const item of response.output ?? []) {
    if (item.type === "reasoning") {
      output.content.push({
        type: "thinking",
        thinking: extractReasoningText(item),
        thinkingSignature: JSON.stringify(item),
      });
      continue;
    }

    if (item.type === "message") {
      output.content.push({
        type: "text",
        text: extractMessageText(item),
        textSignature: item.id,
      });
      continue;
    }

    if (item.type === "function_call") {
      output.content.push({
        type: "toolCall",
        id: `${item.call_id ?? item.id ?? "call"}|${item.id ?? item.call_id ?? "fc"}`,
        name: item.name ?? "unknown",
        arguments: parseJsonArguments(item.arguments),
      });
    }
  }

  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;
  output.usage = {
    input: Math.max(0, (response.usage?.input_tokens ?? 0) - cachedTokens),
    output: response.usage?.output_tokens ?? 0,
    cacheRead: cachedTokens,
    cacheWrite: 0,
    totalTokens: response.usage?.total_tokens ?? 0,
    cost: createBaseUsage().cost,
  };
  calculateCost(model, output.usage);
  applyServiceTierPricing(output.usage, response.service_tier ?? options.serviceTier);
  output.stopReason = mapStopReason(response.status);
  if (output.content.some((block) => block.type === "toolCall") && output.stopReason === "stop") {
    output.stopReason = "toolUse";
  }
}

function isAbortError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function streamOpenAIResponsesNonStreaming(
  model: Model<"openai-responses">,
  context: Context,
  options: OpenAIResponsesStreamOptions | undefined,
) {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const requestOptions = resolveRequestOptions(model, options);
    const output = createBaseAssistantMessage(model);

    try {
      const response = await createResponse(model, context, requestOptions);
      populateAssistantMessage(model, output, response, requestOptions);
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        stream.push({
          type: "error",
          reason: output.stopReason,
          error: output,
        });
        stream.end();
        return;
      }
      stream.push({
        type: "done",
        reason:
          output.stopReason === "toolUse"
            ? "toolUse"
            : output.stopReason === "length"
              ? "length"
              : "stop",
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = isAbortError(error, requestOptions.signal) ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({
        type: "error",
        reason: output.stopReason,
        error: output,
      });
      stream.end();
    }
  })();

  return stream;
}

export function wrapEmbeddedStreamFnWithOpenAIResponsesFallback(
  baseStreamFn: StreamFn = streamSimple,
): StreamFn {
  return (model, context, options) => {
    const typedModel = model as Model<Api>;
    if (!shouldUseNonStreamingResponses(typedModel)) {
      return baseStreamFn(model, context, options);
    }

    return streamOpenAIResponsesNonStreaming(
      typedModel as Model<"openai-responses">,
      context as Context,
      options as OpenAIResponsesStreamOptions | undefined,
    );
  };
}

export const _internal = {
  buildRequestPayload,
  mapStopReason,
  populateAssistantMessage,
  parseResponseBody,
  shouldUseNonStreamingResponses,
};
