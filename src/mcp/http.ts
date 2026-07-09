import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { CliDeps } from "../cli.js";
import type { PlaneAuthConfig } from "../lib/config.js";
import { createPlaneMcpServer } from "./server.js";
import {
  createContextStoreFromEnv,
  type PlaneMcpContextStore,
} from "./session-context.js";

export type PlaneMcpHttpOptions = CliDeps & {
  allowedOrigins?: string[];
  contextStore?: PlaneMcpContextStore;
  host?: string;
  port?: number;
};

type Closeable = {
  close: () => Promise<void>;
  url: string;
};

export async function startPlaneMcpHttpServer(
  options: PlaneMcpHttpOptions = {},
): Promise<Closeable> {
  const env = options.env ?? process.env;
  const host = options.host ?? env.HOST ?? "127.0.0.1";
  const port = options.port ?? Number(env.PORT ?? 3000);
  const cwd = options.cwd ?? env.PLANE_CLI_CWD ?? process.cwd();
  const home = options.home ?? env.PLANE_CLI_HOME ?? env.HOME;
  const allowedOrigins = new Set([
    ...parseAllowedOrigins(env.PLANE_MCP_ALLOWED_ORIGINS),
    ...(options.allowedOrigins ?? []).map((origin) => normalizeOrigin(origin)).filter(isDefined),
  ]);
  const contextStore = options.contextStore ?? createContextStoreFromEnv(env);

  await contextStore.start?.();

  const httpServer = createServer(async (req, res) => {
    const requestUrl = parseRequestUrl(req, host);
    if (!requestUrl) {
      writeHttpError(res, 400, "Bad Request");
      return;
    }

    if (requestUrl.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const originResult = validateOrigin(req, allowedOrigins);
    if (!originResult.ok) {
      writeHttpError(res, 403, "Forbidden origin");
      return;
    }

    if (originResult.origin) {
      setCorsHeaders(req, res, originResult.origin);
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const planeAuth = readPlaneAuth(req);
    if (!planeAuth) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="Plane", X-API-Key',
      });
      res.end(JSON.stringify({ error: "Plane credentials are required" }));
      return;
    }

    try {
      await handleMcpRequest(
        req,
        res,
        {
          cwd,
          disableCredentialPersistence: true,
          env,
          fetch: options.fetch,
          home,
          planeAuth,
        },
        contextStore,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.emitWarning(`Plane MCP request failed: ${message}`);
      if (!res.headersSent) {
        writeHttpError(res, 500, "Internal Server Error");
        return;
      }
      res.destroy(error instanceof Error ? error : new Error(message));
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await contextStore.close?.();
    throw error;
  }

  const address = httpServer.address();
  const selectedPort = typeof address === "object" && address ? address.port : port;
  const urlHost = formatHostForUrl(host);

  return {
    close: async () => {
      await contextStore.close?.();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
    url: `http://${urlHost}:${selectedPort}/mcp`,
  };
}

function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((origin) => normalizeOrigin(origin.trim()))
    .filter(isDefined);
}

function normalizeOrigin(origin: string): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function formatHostForUrl(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function parseRequestUrl(req: IncomingMessage, fallbackHost: string): URL | undefined {
  const hostHeader = req.headers.host;
  const host = typeof hostHeader === "string" && hostHeader.length > 0 ? hostHeader : fallbackHost;
  try {
    return new URL(req.url ?? "/", `http://${host}`);
  } catch {
    return undefined;
  }
}

type OriginValidationResult = { ok: false } | { ok: true; origin?: string };

function validateOrigin(
  req: IncomingMessage,
  allowedOrigins: Set<string>,
): OriginValidationResult {
  const originHeader = req.headers.origin;
  if (originHeader === undefined) return { ok: true };
  if (typeof originHeader !== "string") return { ok: false };

  const origin = normalizeOrigin(originHeader);
  if (!origin) return { ok: false };
  if (allowedOrigins.has(origin)) return { ok: true, origin };

  try {
    return isLocalHost(new URL(origin).hostname) ? { ok: true, origin } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse, origin: string): void {
  const requestedHeaders = req.headers["access-control-request-headers"];
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "POST, DELETE, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    typeof requestedHeaders === "string"
      ? requestedHeaders
      : "authorization, x-api-key, x-plane-api-key, content-type, mcp-session-id, accept",
  );
  res.setHeader("access-control-expose-headers", "mcp-session-id");
  res.setHeader("vary", "Origin, Access-Control-Request-Headers");
}

function isLocalHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host.endsWith(".localhost")
  );
}

function readPlaneAuth(req: IncomingMessage): PlaneAuthConfig | undefined {
  const apiKey =
    headerString(req.headers["x-api-key"]) ?? headerString(req.headers["x-plane-api-key"]);
  if (apiKey) return { apiKey, type: "apiKey" };

  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    const bearerToken = match?.[1]?.trim();
    if (bearerToken) {
      return isPlaneApiKey(bearerToken)
        ? { apiKey: bearerToken, type: "apiKey" }
        : { accessToken: bearerToken, type: "oauth" };
    }
  }

  return undefined;
}

function isPlaneApiKey(value: string): boolean {
  return value.startsWith("plane_api_");
}

function headerString(value: string | string[] | undefined): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  return header && header.trim().length > 0 ? header.trim() : undefined;
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Pick<
    PlaneMcpHttpOptions,
    "cwd" | "disableCredentialPersistence" | "env" | "fetch" | "home" | "planeAuth"
  >,
  contextStore: PlaneMcpContextStore,
): Promise<void> {
  if (req.method === "DELETE") {
    const sessionId = readSessionId(req);
    if (!sessionId) {
      writeJsonRpcError(res, 400, -32000, "Mcp-Session-Id header is required.");
      return;
    }
    if (!(await contextStore.hasSession(sessionId))) {
      writeJsonRpcError(res, 404, -32000, "Invalid MCP session ID.");
      return;
    }
    await contextStore.deleteSession(sessionId);
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    writeJsonRpcError(res, 405, -32000, "Method not allowed.");
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = await readJsonBody(req);
  } catch {
    writeJsonRpcError(res, 400, -32700, "Parse error.");
    return;
  }
  const isInitializationRequest = isInitializeRequest(parsedBody);
  const incomingSessionId = readSessionId(req);

  if (isInitializationRequest && incomingSessionId) {
    writeJsonRpcError(res, 400, -32000, "Initialize requests must not include Mcp-Session-Id.");
    return;
  }

  const sessionId = isInitializationRequest ? randomUUID() : incomingSessionId;
  if (!sessionId) {
    writeJsonRpcError(res, 400, -32000, "MCP session must be initialized first.");
    return;
  }

  const wasInitialized = isInitializationRequest
    ? exposeSessionIdOnSuccessfulResponse(res, sessionId)
    : undefined;

  if (isInitializationRequest) {
    await contextStore.createSession(sessionId);
  } else if (!(await contextStore.hasSession(sessionId))) {
    writeJsonRpcError(res, 404, -32000, "Invalid MCP session ID.");
    return;
  } else {
    await contextStore.touchSession(sessionId);
    res.setHeader("mcp-session-id", sessionId);
  }

  const mcpServer = createPlaneMcpServer({ ...deps, contextStore, sessionId });
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } finally {
    if (isInitializationRequest && !wasInitialized?.()) {
      await contextStore.deleteSession(sessionId);
    }
    await mcpServer.close();
  }
}

function exposeSessionIdOnSuccessfulResponse(res: ServerResponse, sessionId: string): () => boolean {
  let finalStatusCode: number | undefined;
  const originalWriteHead = res.writeHead;
  const originalEnd = res.end;

  const exposeIfSuccessful = (statusCode: number) => {
    finalStatusCode = statusCode;
    if (statusCode >= 200 && statusCode < 300) {
      res.setHeader("mcp-session-id", sessionId);
    } else {
      res.removeHeader("mcp-session-id");
    }
  };

  res.writeHead = function writeHead(
    this: ServerResponse,
    statusCode: number,
    ...args: Parameters<ServerResponse["writeHead"]> extends [number, ...infer Rest] ? Rest : never
  ) {
    exposeIfSuccessful(statusCode);
    return originalWriteHead.apply(this, [statusCode, ...args] as Parameters<ServerResponse["writeHead"]>);
  } as ServerResponse["writeHead"];

  res.end = function end(
    this: ServerResponse,
    ...args: Parameters<ServerResponse["end"]>
  ) {
    if (!res.headersSent) {
      exposeIfSuccessful(finalStatusCode ?? res.statusCode);
    }
    return originalEnd.apply(this, args);
  } as ServerResponse["end"];

  return () => {
    const statusCode = finalStatusCode ?? res.statusCode;
    return statusCode >= 200 && statusCode < 300;
  };
}

function readSessionId(req: IncomingMessage): string | undefined {
  const header = req.headers["mcp-session-id"];
  if (typeof header !== "string" || header.length === 0) return undefined;
  return header;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message }, id: null, jsonrpc: "2.0" }));
}

function writeHttpError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}
