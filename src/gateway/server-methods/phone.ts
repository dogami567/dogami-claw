import { createPhoneManager } from "../../phone/manager.js";
import { PhoneError } from "../../phone/types.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type PhoneCheckParams,
  type PhoneDiscoverParams,
  type PhoneRunParams,
  type PhoneScreenParams,
  type PhoneStatusParams,
  type PhoneStopParams,
  validatePhoneCheckParams,
  validatePhoneDiscoverParams,
  validatePhoneListParams,
  validatePhoneRunParams,
  validatePhoneScreenParams,
  validatePhoneStatusParams,
  validatePhoneStopParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

function toGatewayPhoneError(error: unknown) {
  if (error instanceof PhoneError) {
    return errorShape(
      error.kind === "invalid_request" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
      error.message,
    );
  }
  return errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error));
}

export const phoneHandlers: GatewayRequestHandlers = {
  "phone.list": async ({ params, respond }) => {
    if (!validatePhoneListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid phone.list params: ${formatValidationErrors(validatePhoneListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      respond(true, createPhoneManager().list());
    } catch (error) {
      respond(false, undefined, toGatewayPhoneError(error));
    }
  },

  "phone.discover": async ({ params, respond }) => {
    if (!validatePhoneDiscoverParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid phone.discover params: ${formatValidationErrors(validatePhoneDiscoverParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const result = await createPhoneManager().discover((params as PhoneDiscoverParams).accountId);
      respond(true, result);
    } catch (error) {
      respond(false, undefined, toGatewayPhoneError(error));
    }
  },

  "phone.status": async ({ params, respond }) => {
    if (!validatePhoneStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid phone.status params: ${formatValidationErrors(validatePhoneStatusParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const result = await createPhoneManager().status((params as PhoneStatusParams).accountId);
      respond(true, result);
    } catch (error) {
      respond(false, undefined, toGatewayPhoneError(error));
    }
  },

  "phone.check": async ({ params, respond }) => {
    if (!validatePhoneCheckParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid phone.check params: ${formatValidationErrors(validatePhoneCheckParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const result = await createPhoneManager().check((params as PhoneCheckParams).accountId);
      respond(true, result);
    } catch (error) {
      respond(false, undefined, toGatewayPhoneError(error));
    }
  },

  "phone.screen": async ({ params, respond }) => {
    if (!validatePhoneScreenParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid phone.screen params: ${formatValidationErrors(validatePhoneScreenParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const result = await createPhoneManager().screen(params as PhoneScreenParams);
      respond(true, result);
    } catch (error) {
      respond(false, undefined, toGatewayPhoneError(error));
    }
  },

  "phone.run": async ({ params, respond }) => {
    if (!validatePhoneRunParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid phone.run params: ${formatValidationErrors(validatePhoneRunParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const result = await createPhoneManager().run(params as PhoneRunParams);
      respond(true, result);
    } catch (error) {
      respond(false, undefined, toGatewayPhoneError(error));
    }
  },

  "phone.stop": async ({ params, respond }) => {
    if (!validatePhoneStopParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid phone.stop params: ${formatValidationErrors(validatePhoneStopParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const result = await createPhoneManager().stop(params as PhoneStopParams);
      respond(true, result);
    } catch (error) {
      respond(false, undefined, toGatewayPhoneError(error));
    }
  },
};
