import { z } from "zod";

export const PhoneRuntimeProviderSchema = z.literal("autoglm");

export const PhoneRuntimeConfigSchema = z
  .object({
    provider: PhoneRuntimeProviderSchema.optional(),
    apiUrl: z.string().optional(),
    uiUrl: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .optional();

export const PhoneModelConfigSchema = z
  .object({
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    apiKey: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    monitorBaseUrl: z.string().optional(),
    monitorModel: z.string().optional(),
    monitorApiKey: z.string().optional(),
    monitorTemperature: z.number().min(0).max(2).optional(),
    monitorPrompt: z.string().optional(),
  })
  .strict()
  .optional();

export const PhoneModeSchema = z.union([z.literal("direct"), z.literal("monitor")]);

export const PhoneDefaultsConfigSchema = z
  .object({
    mode: PhoneModeSchema.optional(),
    lang: z.string().optional(),
    maxSteps: z.number().int().positive().optional(),
    maxRounds: z.number().int().positive().optional(),
    executorMaxSteps: z.number().int().positive().optional(),
    monitorUseScreenshot: z.boolean().optional(),
    simulate: z.boolean().optional(),
    simulateMonitor: z.boolean().optional(),
    simulateExecutor: z.boolean().optional(),
  })
  .strict()
  .optional();

export const PhoneAccountConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    deviceId: z.string().optional(),
    deviceType: z.string().optional(),
    runtime: PhoneRuntimeConfigSchema,
    model: PhoneModelConfigSchema,
    defaults: PhoneDefaultsConfigSchema,
  })
  .strict();

export const PhonesSchema = z
  .object({
    defaultAccountId: z.string().optional(),
    accounts: z.record(z.string(), PhoneAccountConfigSchema).optional(),
  })
  .strict()
  .optional();
