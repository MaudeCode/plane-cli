import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { CliDeps } from "../cli.js";
import { createPlaneMcpServer } from "./server.js";

export type PlaneMcpHttpOptions = CliDeps & {
  allowUnauthenticated?: boolean;
  authToken?: string;
  host?: string;
  port?: number;
};

type Closeable = {
  close: () => Promise<void>;
  url: string;
};

type Session = {
  close: () => Promise<void>;
  transport: StreamableHTTPServerTransport;
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

  if (!authToken && !allowUnauthenticated && isPublicHost(host)) {
    throw new Error("PLANE_MCP_AUTH_TOKEN is required when binding MCP to a public interface.");
  }

  const sessions = new Map<string, Session>();

  const httpServer = createServer(async (req, res) => {
    if (new URL(req.url ?? "/", `http://${req.headers.host ?? host}`).pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
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

    await handleMcpRequest(req, res, { cwd, env, fetch: options.fetch, home }, sessions);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const selectedPort = typeof address === "object" && address ? address.port : port;
  const urlHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;

  return {
    close: async () => {
      await Promise.all([...sessions.values()].map((session) => session.close()));
      sessions.clear();
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

function isPublicHost(host: string): boolean {
  return !(
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
  sessions: Map<string, Session>,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"];
  if (typeof sessionId === "string") {
    const session = sessions.get(sessionId);
    if (!session) {
      writeJsonRpcError(res, 404, -32000, "Invalid MCP session ID.");
      return;
    }
    await session.transport.handleRequest(req, res);
    return;
  }

  const parsedBody = await readJsonBody(req);
  if (!isInitializeRequest(parsedBody)) {
    writeJsonRpcError(res, 400, -32000, "MCP session must be initialized first.");
    return;
  }

  let initializedSessionId: string | undefined;
  const mcpServer = createPlaneMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({
    onsessioninitialized: (newSessionId) => {
      initializedSessionId = newSessionId;
      sessions.set(newSessionId, {
        close: async () => {
          await transport.close();
          await mcpServer.close();
        },
        transport,
      });
    },
    sessionIdGenerator: () => randomUUID(),
  });

  transport.onclose = () => {
    const id = initializedSessionId ?? transport.sessionId;
    if (id) sessions.delete(id);
  };

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
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
