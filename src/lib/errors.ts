import { ZodError } from "zod";

export type ErrorCode =
  | "WORKSPACE_NOT_RESOLVED"
  | "WORKSPACE_NOT_FOUND"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "MISSING_PLANE_API_KEY"
  | "PLANE_AUTH_FAILED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "API_ERROR"
  | "UNKNOWN_ERROR";

export const exitCodes = {
  success: 0,
  generic: 1,
  validationOrConfig: 2,
  notFound: 3,
  auth: 4,
  api: 5,
} as const;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly exitCode: number;

  constructor(
    code: ErrorCode,
    message: string,
    exitCode: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export class ValidationAppError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("VALIDATION_ERROR", message, exitCodes.validationOrConfig, details);
  }
}

export class ConfigNotFoundError extends AppError {
  constructor(searchPaths: string[]) {
    super("CONFIG_NOT_FOUND", "No plane-cli config file found", exitCodes.validationOrConfig, {
      searchPaths,
    });
  }
}

export class ConfigInvalidError extends AppError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("CONFIG_INVALID", message, exitCodes.validationOrConfig, details);
  }
}

export class MissingPlaneApiKeyError extends AppError {
  constructor(workspace?: string) {
    super(
      "MISSING_PLANE_API_KEY",
      workspace
        ? `Workspace '${workspace}' is missing a Plane API key.`
        : "Configured workspace is missing a Plane API key.",
      exitCodes.validationOrConfig,
      workspace ? { workspace } : {},
    );
  }
}

export class WorkspaceNotResolvedError extends AppError {
  constructor() {
    super(
      "WORKSPACE_NOT_RESOLVED",
      "No active Plane workspace could be determined.",
      exitCodes.validationOrConfig,
    );
  }
}

export class WorkspaceNotFoundError extends AppError {
  constructor(workspace: string) {
    super(
      "WORKSPACE_NOT_FOUND",
      `Workspace '${workspace}' is not configured.`,
      exitCodes.validationOrConfig,
      { workspace },
    );
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, lookup: string) {
    super("NOT_FOUND", `No Plane ${resource} found for ${lookup}`, exitCodes.notFound, {
      lookup,
      resource,
    });
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new ValidationAppError("Input validation failed", { issues: error.issues });
  }
  if (error instanceof Error) {
    const message = error.message || "Unknown error";
    if (/auth|unauthorized|forbidden/i.test(message)) {
      return new AppError("PLANE_AUTH_FAILED", message, exitCodes.auth);
    }
    if (/network|fetch|timeout|rate limit|plane|api|http/i.test(message)) {
      return new AppError("API_ERROR", message, exitCodes.api);
    }
    return new AppError("UNKNOWN_ERROR", message, exitCodes.generic);
  }
  return new AppError("UNKNOWN_ERROR", "Unknown error", exitCodes.generic);
}
