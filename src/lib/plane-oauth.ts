import { AppError, ValidationAppError, exitCodes } from "./errors.js";
import type { FetchLike, JsonObject, JsonValue } from "./plane-client.js";

export type PlaneOAuthGrant =
  | {
      appInstallationId: string;
      baseUrl: string;
      clientId: string;
      clientSecret: string;
      grantType: "client_credentials";
    }
  | {
      baseUrl: string;
      clientId: string;
      clientSecret: string;
      code: string;
      grantType: "authorization_code";
      redirectUri: string;
    };

export type PlaneOAuthToken = {
  accessToken: string;
  expiresAt?: string;
  refreshToken?: string;
  scopes?: string[];
  tokenType?: string;
};

export function buildPlaneOAuthAuthorizeUrl(options: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  state: string;
}): string {
  const url = new URL("/auth/o/authorize-app/", normalizedBaseUrl(options.baseUrl));
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  if (options.scopes?.length) url.searchParams.set("scope", options.scopes.join(" "));
  url.searchParams.set("state", options.state);
  return url.toString();
}

export async function exchangePlaneOAuthToken(
  grant: PlaneOAuthGrant,
  options: { fetch?: FetchLike; now?: Date } = {},
): Promise<PlaneOAuthToken> {
  const fetcher = options.fetch ?? fetch;
  const body = new URLSearchParams();
  body.set("grant_type", grant.grantType);
  if (grant.grantType === "client_credentials") {
    body.set("app_installation_id", grant.appInstallationId);
  } else {
    body.set("client_id", grant.clientId);
    body.set("client_secret", grant.clientSecret);
    body.set("code", grant.code);
    body.set("redirect_uri", grant.redirectUri);
  }

  const response = await fetcher(new URL("/auth/o/token/", normalizedBaseUrl(grant.baseUrl)).toString(), {
    body: body.toString(),
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${grant.clientId}:${grant.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  const parsed = await parseOAuthResponse(response);
  const accessToken = stringValue(parsed, "access_token") ?? stringValue(parsed, "accessToken");
  if (!accessToken) {
    throw new AppError("API_ERROR", "Plane OAuth token response did not include an access token.", exitCodes.api, {
      keys: Object.keys(parsed),
    });
  }
  const expiresIn = numberValue(parsed, "expires_in") ?? numberValue(parsed, "expiresIn");
  const scope = stringValue(parsed, "scope");
  return {
    accessToken,
    expiresAt:
      expiresIn === undefined ? undefined : new Date((options.now ?? new Date()).getTime() + expiresIn * 1000).toISOString(),
    refreshToken: stringValue(parsed, "refresh_token") ?? stringValue(parsed, "refreshToken"),
    scopes: scope ? scope.split(/\s+/).filter(Boolean) : undefined,
    tokenType: stringValue(parsed, "token_type") ?? stringValue(parsed, "tokenType"),
  };
}

function normalizedBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/`;
}

async function parseOAuthResponse(response: Response): Promise<JsonObject> {
  const text = await response.text();
  const parsed = text ? safeJson(text) : {};
  if (response.status >= 200 && response.status < 300) {
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as JsonObject;
    throw new AppError("API_ERROR", "Plane OAuth token response was not a JSON object.", exitCodes.api);
  }
  const message =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? stringValue(parsed as JsonObject, "error_description") ??
        stringValue(parsed as JsonObject, "detail") ??
        stringValue(parsed as JsonObject, "error")
      : undefined;
  if (response.status === 400) {
    throw new ValidationAppError(message ?? "Plane OAuth token request was rejected.", {
      body: parsed,
      status: response.status,
    });
  }
  if (response.status === 401 || response.status === 403) {
    throw new AppError("PLANE_AUTH_FAILED", message ?? "Plane OAuth authentication failed.", exitCodes.auth, {
      body: parsed,
      status: response.status,
    });
  }
  if (response.status === 404) {
    throw new AppError("NOT_FOUND", "Plane OAuth endpoints are not available on this instance.", exitCodes.notFound, {
      body: parsed,
      status: response.status,
    });
  }
  throw new AppError("API_ERROR", message ?? `Plane OAuth request failed with status ${response.status}`, exitCodes.api, {
    body: parsed,
    status: response.status,
  });
}

function safeJson(text: string): JsonValue {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isJsonValue(parsed) ? parsed : { value: String(parsed) };
  } catch {
    return { body: text };
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object";
}

function stringValue(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function numberValue(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" ? value : undefined;
}
