import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";

import { log } from "./logger.js";

function isStreamReadErrorMessage(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw.toLowerCase().includes("stream_read_error");
}

function hasTerminalUsage(msg: AssistantMessage): boolean {
  return (msg.usage?.totalTokens ?? 0) > 0;
}

function hasAnyNonEmptyText(msg: AssistantMessage): boolean {
  for (const block of msg.content) {
    if (block.type !== "text") continue;
    if (block.text.trim().length > 0) return true;
  }
  return false;
}

function hasAnyTextSignature(msg: AssistantMessage): boolean {
  return msg.content.some((block) => block.type === "text" && Boolean(block.textSignature));
}

function shouldRecoverFromStreamReadError(msg: AssistantMessage): boolean {
  if (msg.stopReason !== "error") return false;
  if (!isStreamReadErrorMessage(msg.errorMessage)) return false;
  if (!hasAnyNonEmptyText(msg)) return false;
  // Heuristic: If we got a completed usage payload or we saw text signatures,
  // the stream likely finished and only the final read errored.
  return hasTerminalUsage(msg) || hasAnyTextSignature(msg);
}

function recoverAssistantMessage(msg: AssistantMessage): AssistantMessage {
  const hasToolCalls = msg.content.some((block) => block.type === "toolCall");
  const recoveredStopReason = hasToolCalls ? "toolUse" : "stop";
  const { errorMessage: _ignored, ...rest } = msg;
  return {
    ...rest,
    stopReason: recoveredStopReason,
  };
}

export type StreamReadErrorRecoveryOptions = {
  /**
   * Retries when the provider errors with `stream_read_error` *before* emitting a start event.
   * This avoids inserting a partial assistant message into context.
   */
  maxRetries?: number;
};

export function wrapStreamFnForStreamReadErrorRecovery(
  baseStreamFn: StreamFn,
  options?: StreamReadErrorRecoveryOptions,
): StreamFn {
  const maxRetries = Math.max(0, Math.floor(options?.maxRetries ?? 1));

  return async (model, context, streamOptions) => {
    const out = new AssistantMessageEventStream();

    void (async () => {
      for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
        let sawStart = false;
        let shouldRetry = false;

        const inner = await baseStreamFn(model, context, streamOptions);

        try {
          for await (const event of inner) {
            if (event.type === "start") {
              sawStart = true;
              out.push(event);
              continue;
            }

            if (event.type === "done") {
              out.push(event);
              out.end();
              return;
            }

            if (event.type === "error") {
              const finalMessage = await inner.result();
              const streamReadError = isStreamReadErrorMessage(finalMessage.errorMessage);

              if (streamReadError && shouldRecoverFromStreamReadError(finalMessage)) {
                const recovered = recoverAssistantMessage(finalMessage);
                log.warn(
                  `Recovered stream_read_error for ${model.provider}/${model.id} (api=${model.api}).`,
                );
                out.push({ type: "done", reason: recovered.stopReason, message: recovered });
                out.end();
                return;
              }

              if (
                streamReadError &&
                !sawStart &&
                attemptIndex < maxRetries &&
                !streamOptions?.signal?.aborted
              ) {
                log.warn(
                  `stream_read_error before start for ${model.provider}/${model.id} (api=${model.api}); retrying (${attemptIndex + 1}/${maxRetries}).`,
                );
                shouldRetry = true;
                break;
              }

              out.push(event);
              out.end();
              return;
            }

            out.push(event);
          }

          if (shouldRetry) continue;

          const finalMessage = await inner.result();
          if (shouldRecoverFromStreamReadError(finalMessage)) {
            const recovered = recoverAssistantMessage(finalMessage);
            log.warn(
              `Recovered stream_read_error for ${model.provider}/${model.id} (api=${model.api}) without terminal event.`,
            );
            out.push({ type: "done", reason: recovered.stopReason, message: recovered });
            out.end();
            return;
          }

          if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
            out.push({ type: "error", reason: finalMessage.stopReason, error: finalMessage });
          } else {
            out.push({ type: "done", reason: finalMessage.stopReason, message: finalMessage });
          }
          out.end();
          return;
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const streamReadError = isStreamReadErrorMessage(errorMessage);
          if (
            streamReadError &&
            !sawStart &&
            attemptIndex < maxRetries &&
            !streamOptions?.signal?.aborted
          ) {
            log.warn(
              `stream_read_error before start for ${model.provider}/${model.id} (api=${model.api}); retrying (${attemptIndex + 1}/${maxRetries}).`,
            );
            continue;
          }
          throw err;
        }
      }
    })().catch((err) => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
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
        },
        stopReason: streamOptions?.signal?.aborted ? "aborted" : "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      out.push({ type: "error", reason: message.stopReason, error: message });
      out.end();
    });

    return out;
  };
}
