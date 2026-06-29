import { toAppError } from "./errors.js";

export type JsonErrorOutput = {
  body: string;
  exitCode: number;
};

export function jsonSuccess<T>(data: T, workspace?: string): string {
  return JSON.stringify(workspace ? { ok: true, workspace, data } : { ok: true, data });
}

export function jsonError(error: unknown): JsonErrorOutput {
  const appError = toAppError(error);
  return {
    body: JSON.stringify({
      ok: false,
      error: {
        code: appError.code,
        message: appError.message,
        details: sanitizeErrorDetails(appError.details),
      },
    }),
    exitCode: appError.exitCode,
  };
}

function sanitizeErrorDetails(details: Record<string, unknown>): Record<string, unknown> {
  return sanitizeDetailValue(details, new WeakSet<object>()) as Record<string, unknown>;
}

function sanitizeDetailValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value.map((item) => sanitizeDetailValue(item, seen));
    seen.delete(value);
    return output;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isSensitiveDetailKey(key)) continue;
    output[key] = sanitizeDetailValue(nestedValue, seen);
  }
  seen.delete(value);
  return output;
}

function isSensitiveDetailKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized === "body" ||
    normalized === "responsebody" ||
    normalized === "requestbody" ||
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized === "secret" ||
    normalized.endsWith("secret") ||
    normalized === "password" ||
    normalized === "passwd" ||
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "apikey" ||
    normalized.endsWith("apikey")
  );
}
