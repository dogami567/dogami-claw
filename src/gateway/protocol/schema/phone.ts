import { Type } from "@sinclair/typebox";

import { NonEmptyString } from "./primitives.js";

const PhoneModeSchema = Type.Unsafe<"direct" | "monitor">({
  type: "string",
  enum: ["direct", "monitor"],
});

export const PhoneListParamsSchema = Type.Object({}, { additionalProperties: false });

export const PhoneDiscoverParamsSchema = Type.Object(
  {
    accountId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PhoneStatusParamsSchema = Type.Object(
  {
    accountId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PhoneCheckParamsSchema = Type.Object(
  {
    accountId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PhoneScreenParamsSchema = Type.Object(
  {
    accountId: Type.Optional(NonEmptyString),
    deviceId: Type.Optional(NonEmptyString),
    deviceType: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PhoneRunParamsSchema = Type.Object(
  {
    accountId: Type.Optional(NonEmptyString),
    mode: Type.Optional(PhoneModeSchema),
    task: Type.Optional(NonEmptyString),
    goal: Type.Optional(NonEmptyString),
    waitForCompletion: Type.Optional(Type.Boolean()),
    waitTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    deviceId: Type.Optional(NonEmptyString),
    deviceType: Type.Optional(NonEmptyString),
    lang: Type.Optional(NonEmptyString),
    maxSteps: Type.Optional(Type.Integer({ minimum: 1 })),
    maxRounds: Type.Optional(Type.Integer({ minimum: 1 })),
    executorMaxSteps: Type.Optional(Type.Integer({ minimum: 1 })),
    simulate: Type.Optional(Type.Boolean()),
    dryRun: Type.Optional(Type.Boolean()),
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    baseUrl: Type.Optional(NonEmptyString),
    model: Type.Optional(NonEmptyString),
    apiKey: Type.Optional(Type.String()),
    monitorBaseUrl: Type.Optional(NonEmptyString),
    monitorModel: Type.Optional(NonEmptyString),
    monitorApiKey: Type.Optional(Type.String()),
    monitorUseScreenshot: Type.Optional(Type.Boolean()),
    monitorTemperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    monitorPrompt: Type.Optional(NonEmptyString),
    includeScreenshot: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PhoneStopParamsSchema = Type.Object(
  {
    accountId: Type.Optional(NonEmptyString),
    runId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
