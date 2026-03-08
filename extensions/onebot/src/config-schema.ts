import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
  buildChannelConfigSchema,
} from "clawdbot/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

export const OneBotAiKpConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    storageRoot: z.string().optional(),
    bypassMentionWhenActive: z.boolean().optional(),
    summaryChunkLimit: z.number().int().positive().optional(),
    recentChatLimit: z.number().int().positive().optional(),
    recentOperationLimit: z.number().int().positive().optional(),
    includeLogHint: z.boolean().optional(),
  })
  .strict();

export const OneBotGroupConfigSchema = z
  .object({
    requireMention: z.boolean().optional(),
    systemPrompt: z.string().optional(),
    tools: ToolPolicySchema.optional(),
  })
  .strict();

export type OneBotGroupConfig = z.infer<typeof OneBotGroupConfigSchema>;

export const OneBotConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema,

    /** OneBot HTTP API base URL (used for outbound and probing). */
    httpUrl: z.string().optional(),

    /** OneBot WebSocket URL for inbound events. */
    wsUrl: z.string().optional(),

    /** Optional OneBot access token (Authorization: Bearer ...). */
    accessToken: z.string().optional(),

    /** HTTP timeout (ms) for OneBot API calls. */
    apiTimeoutMs: z.number().int().positive().optional(),

    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(allowFromEntry).optional(),

    groupPolicy: GroupPolicySchema.optional(),
    groupAllowFrom: z.array(allowFromEntry).optional(),

    /** Group allowlist + per-group config (requireMention/tools). */
    groups: z.record(z.string(), OneBotGroupConfigSchema.optional()).optional(),
    aiKp: OneBotAiKpConfigSchema.optional(),
  })
  .strict();

export type OneBotConfig = z.infer<typeof OneBotConfigSchema>;

export const onebotChannelConfigSchema = buildChannelConfigSchema(OneBotConfigSchema);
