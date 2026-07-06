import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { CliDeps } from "../cli.js";
import { createPlaneMcpServer } from "./server.js";
import {
  createContextStoreFromEnv,
  type PlaneMcpContextStore,
} from "./session-context.js";

export type PlaneMcpHttpOptions = CliDeps & {
  allowUnauthenticated?: boolean;
  allowedOrigins?: string[];
  authToken?: string;
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
  const authToken = nonEmpty(options.authToken) ?? nonEmpty(env.PLANE_MCP_AUTH_TOKEN);
  const allowUnauthenticated =
    options.allowUnauthenticated ?? env.PLANE_MCP_ALLOW_UNAUTHENTICATED === "true";
  const allowedOrigins = new Set([
    ...parseAllowedOrigins(env.PLANE_MCP_ALLOWED_ORIGINS),
    ...(options.allowedOrigins ?? []).map((origin) => normalizeOrigin(origin)).filter(isDefined),
  ]);
  const contextStore = options.contextStore ?? createContextStoreFromEnv(env);

  if (!authToken && !allowUnauthenticated && isPublicHost(host)) {
    throw new Error("PLANE_MCP_AUTH_TOKEN is required when binding MCP to a public interface.");
  }

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

    if (!hasAllowedOrigin(req, allowedOrigins)) {
      writeHttpError(res, 403, "Forbidden origin");
      return;
    }

    if (authToken && !hasBearerToken(req, authToken)) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    await handleMcpRequest(
      req,
      res,
      { cwd, env, fetch: options.fetch, home },
      contextStore,
    );
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
  const urlHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

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

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
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

function isPublicHost(host: string): boolean {
  return !(
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host.endsWith(".localhost")
  );
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

function hasAllowedOrigin(req: IncomingMessage, allowedOrigins: Set<string>): boolean {
  const originHeader = req.headers.origin;
  if (originHeader === undefined) return true;
  if (typeof originHeader !== "string") return false;

  const origin = normalizeOrigin(originHeader);
  if (!origin) return false;
  if (allowedOrigins.has(origin)) return true;

  try {
    return isLocalHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isLocalHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host.endsWith(".localhost")
  );
}

function hasBearerToken(req: IncomingMessage, expectedToken: string): boolean {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return false;

  const expected = `Bearer ${expectedToken}`;
  const actualBuffer = Buffer.from(authorization);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Pick<PlaneMcpHttpOptions, "cwd" | "env" | "fetch" | "home">,
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
