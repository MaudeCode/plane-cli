import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPlaneMcpServer } from "./server.js";

export type PlaneMcpHttpOptions = {
  allowUnauthenticated?: boolean;
  authToken?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  home?: string;
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

  if (!authToken && !allowUnauthenticated && isPublicHost(host)) {
    throw new Error("PLANE_MCP_AUTH_TOKEN is required when binding MCP to a public interface.");
  }

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

    await handleMcpRequest(req, res, { cwd, env, home });
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
  deps: Pick<PlaneMcpHttpOptions, "cwd" | "env" | "home">,
): Promise<void> {
  const mcpServer = createPlaneMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } finally {
    await transport.close();
    await mcpServer.close();
  }
}
