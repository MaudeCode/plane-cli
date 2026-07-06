import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test, vi } from "vitest";
import { createPlaneMcpServer } from "../src/mcp/server.js";
import { startPlaneMcpHttpServer } from "../src/mcp/http.js";
import { createMemoryContextStore } from "../src/mcp/session-context.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plane-cli-mcp-test-"));
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

async function connectClient(server = createPlaneMcpServer({ env: {} })): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function rpc(
  url: string,
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const res = await fetch(url, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });

  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  const text = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const dataLine = text
      .split("\n")
      .find((line) => line.startsWith("data: ") && line.includes('"jsonrpc"'));
    expect(dataLine).toBeTruthy();
    return JSON.parse(dataLine!.slice("data: ".length));
  }
  return JSON.parse(text);
}

async function rawHttpRequest(port: number, request: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.setTimeout(1_000);
    socket.on("connect", () => {
      socket.write(request);
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
    });
    socket.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("timeout", () => {
      socket.destroy(new Error("Timed out waiting for raw HTTP response."));
    });
    socket.on("error", reject);
  });
}

describe("Plane MCP server", () => {
  test("registers high-value typed tools", async () => {
    const client = await connectClient();

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "issue_get",
        "plane_context_clear",
        "plane_context_get",
        "plane_context_set",
        "project_list",
        "comment_create",
      ]),
    );
    expect(names).not.toContain("plane_tool_call");
    expect(tools.find((tool) => tool.name === "project_list")).toMatchObject({
      annotations: { destructiveHint: false, readOnlyHint: true },
      inputSchema: {
        properties: expect.objectContaining({
          workspace: expect.objectContaining({ type: "string" }),
        }),
      },
    });
    expect(tools.find((tool) => tool.name === "comment_create")).toMatchObject({
      annotations: { destructiveHint: false, readOnlyHint: false },
    });
    expect(tools.find((tool) => tool.name === "workspace_validate")).toMatchObject({
      annotations: { destructiveHint: false, readOnlyHint: true },
    });
    expect(tools.find((tool) => tool.name === "issue_advanced_search")).toMatchObject({
      annotations: { destructiveHint: false, readOnlyHint: true },
    });
    expect(tools.find((tool) => tool.name === "project_unarchive")).toMatchObject({
      annotations: { destructiveHint: false, readOnlyHint: false },
    });
    expect(tools.find((tool) => tool.name === "module_add_item")).toMatchObject({
      annotations: { destructiveHint: false, readOnlyHint: false },
    });
    expect(tools.find((tool) => tool.name === "issue_attachment_upload")).toMatchObject({
      annotations: { destructiveHint: false, readOnlyHint: false },
    });
  });

  test("serves typed tools over Streamable HTTP", async () => {
    const server = await startPlaneMcpHttpServer({ env: {}, host: "127.0.0.1", port: 0 });
    try {
      const headers: Record<string, string> = {};
      await rpc(server.url, "initialize", {
        capabilities: {},
        clientInfo: { name: "raw-json-rpc-test", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      }, headers);

      const listResponse = (await rpc(server.url, "tools/list", undefined, headers)) as {
        result: { tools: Array<{ inputSchema: unknown; name: string }> };
      };
      const names = listResponse.result.tools.map((tool) => tool.name);

      expect(names).toEqual(expect.arrayContaining(["issue_get", "project_list", "comment_create"]));
      expect(names).not.toContain("plane_tool_call");
      expect(listResponse.result.tools.find((tool) => tool.name === "issue_get")).toMatchObject({
        inputSchema: {
          properties: expect.objectContaining({
            issue: expect.objectContaining({ type: "string" }),
            project: expect.objectContaining({ type: "string" }),
          }),
          required: expect.arrayContaining(["issue"]),
          type: "object",
        },
      });
      const issueGetSchema = listResponse.result.tools.find((tool) => tool.name === "issue_get")
        ?.inputSchema as { required?: string[] };
      expect(issueGetSchema.required ?? []).not.toContain("project");
    } finally {
      await server.close();
    }
  });

  test("requires an auth token for public hosted binds", async () => {
    await expect(
      startPlaneMcpHttpServer({ env: {}, host: "0.0.0.0", port: 0 }),
    ).rejects.toThrow("PLANE_MCP_AUTH_TOKEN is required");
    await expect(
      startPlaneMcpHttpServer({ env: {}, host: "203.0.113.10", port: 0 }),
    ).rejects.toThrow("PLANE_MCP_AUTH_TOKEN is required");
  });

  test("closes the context store when HTTP listen fails after store startup", async () => {
    const server = await startPlaneMcpHttpServer({ env: {}, host: "127.0.0.1", port: 0 });
    const port = Number(new URL(server.url).port);
    const backingStore = createMemoryContextStore();
    const contextStore = {
      ...backingStore,
      close: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
    };

    try {
      await expect(
        startPlaneMcpHttpServer({
          contextStore,
          env: {},
          host: "127.0.0.1",
          port,
        }),
      ).rejects.toThrow();
      expect(contextStore.start).toHaveBeenCalledTimes(1);
      expect(contextStore.close).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  test("enforces bearer auth when configured", async () => {
    const server = await startPlaneMcpHttpServer({
      authToken: "mcp-secret",
      env: {},
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const unauthorized = await fetch(server.url, {
        body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "tools/list" }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(unauthorized.status).toBe(401);

      const headers = { authorization: "Bearer mcp-secret" };
      await rpc(
        server.url,
        "initialize",
        {
          capabilities: {},
          clientInfo: { name: "auth-test", version: "0.0.0" },
          protocolVersion: "2025-06-18",
        },
        headers,
      );
      const listResponse = (await rpc(
        server.url,
        "tools/list",
        undefined,
        headers,
      )) as { result: { tools: Array<{ name: string }> } };
      expect(listResponse.result.tools.some((tool) => tool.name === "issue_get")).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("rejects unexpected browser origins before MCP handling", async () => {
    const server = await startPlaneMcpHttpServer({ env: {}, host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(server.url, {
        body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "tools/list" }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        method: "POST",
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Forbidden origin" });
    } finally {
      await server.close();
    }
  });

  test("allows explicitly configured browser origins", async () => {
    const server = await startPlaneMcpHttpServer({
      env: { PLANE_MCP_ALLOWED_ORIGINS: "https://agent.example" },
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const headers = { origin: "https://agent.example" };
      await rpc(server.url, "initialize", {
        capabilities: {},
        clientInfo: { name: "origin-test", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      }, headers);
      expect(headers).toHaveProperty("mcp-session-id");
    } finally {
      await server.close();
    }
  });

  test("returns a normal 400 response for malformed Host headers", async () => {
    const server = await startPlaneMcpHttpServer({ env: {}, host: "127.0.0.1", port: 0 });
    const port = Number(new URL(server.url).port);
    try {
      const responseText = await rawHttpRequest(
        port,
        [
          "POST /mcp HTTP/1.1",
          "Host: [",
          "Accept: application/json, text/event-stream",
          "Content-Type: application/json",
          "Connection: close",
          "Content-Length: 2",
          "",
          "{}",
        ].join("\r\n"),
      );

      expect(responseText).toContain("HTTP/1.1 400");
      expect(responseText).toContain('"error":"Bad Request"');
    } finally {
      await server.close();
    }
  });

  test("returns structured success content from tool calls", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi.fn(async () =>
      response({ next_page_results: false, results: [{ id: "P1", name: "Web" }] }),
    );
    const client = await connectClient(createPlaneMcpServer({ cwd, env: {}, fetch, home: cwd }));

    const result = await client.callTool({
      arguments: { workspace: "prod" },
      name: "project_list",
    });

    expect(result.structuredContent).toEqual({
      data: [{ id: "P1", name: "Web" }],
      ok: true,
      workspace: "prod",
    });
    expect((result.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      text: JSON.stringify({ ok: true, workspace: "prod", data: [{ id: "P1", name: "Web" }] }),
      type: "text",
    });
  });

  test("uses session context for repo-scoped MCP execution", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      )
      .mockResolvedValueOnce(response({ id: "ISSUE-ID", name: "Fix login", sequence_id: 123 }));
    const client = await connectClient(createPlaneMcpServer({ cwd, env: {}, fetch, home: cwd }));

    await client.callTool({
      arguments: { project: "Web", workspace: "prod" },
      name: "plane_context_set",
    });
    const result = await client.callTool({
      arguments: { title: "Fix login" },
      name: "issue_create",
    });

    expect(result.structuredContent).toMatchObject({
      data: { id: "ISSUE-ID", identifier: "WEB-123", name: "Fix login" },
      ok: true,
      workspace: "prod",
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/",
    );
  });

  test("returns the normalized context from plane_context_set", async () => {
    const client = await connectClient(createPlaneMcpServer({ env: {} }));

    try {
      const setResult = await client.callTool({
        arguments: { project: " Web ", workspace: " prod " },
        name: "plane_context_set",
      });
      const getResult = await client.callTool({ arguments: {}, name: "plane_context_get" });

      expect(setResult.structuredContent).toEqual({
        data: { project: "Web", workspace: "prod" },
        ok: true,
      });
      expect(getResult.structuredContent).toEqual(setResult.structuredContent);
    } finally {
      await client.close();
    }
  });

  test("isolates Plane context by MCP session id in a shared context store", async () => {
    const contextStore = createMemoryContextStore();
    const clientA = await connectClient(
      createPlaneMcpServer({ contextStore, env: {}, sessionId: "session-a" }),
    );
    const clientB = await connectClient(
      createPlaneMcpServer({ contextStore, env: {}, sessionId: "session-b" }),
    );

    try {
      await clientA.callTool({
        arguments: { project: "PCLI", workspace: "MaudeCode" },
        name: "plane_context_set",
      });
      await clientB.callTool({
        arguments: { project: "WEB", workspace: "Personal" },
        name: "plane_context_set",
      });

      await expect(clientA.callTool({ arguments: {}, name: "plane_context_get" })).resolves
        .toMatchObject({
          structuredContent: {
            data: { project: "PCLI", workspace: "MaudeCode" },
            ok: true,
          },
        });
      await expect(clientB.callTool({ arguments: {}, name: "plane_context_get" })).resolves
        .toMatchObject({
          structuredContent: {
            data: { project: "WEB", workspace: "Personal" },
            ok: true,
          },
        });
    } finally {
      await Promise.all([clientA.close(), clientB.close()]);
    }
  });

  test("persists session context over Streamable HTTP", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi.fn(async () =>
      response({ next_page_results: false, results: [{ id: "PROJECT-ID", name: "Web" }] }),
    );
    const server = await startPlaneMcpHttpServer({
      cwd,
      env: {},
      fetch,
      home: cwd,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const client = new Client({ name: "http-context-test", version: "0.0.0" });
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

      await client.callTool({
        arguments: { project: "Web", workspace: "prod" },
        name: "plane_context_set",
      });
      const context = await client.callTool({ arguments: {}, name: "plane_context_get" });
      const projects = await client.callTool({ arguments: {}, name: "project_list" });

      expect(context.structuredContent).toEqual({
        data: { project: "Web", workspace: "prod" },
        ok: true,
      });
      expect(projects.structuredContent).toEqual({
        data: [{ id: "PROJECT-ID", name: "Web" }],
        ok: true,
        workspace: "prod",
      });
      await client.close();
    } finally {
      await server.close();
    }
  });

  test("allows non-sticky Streamable HTTP requests when replicas share a context store", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi.fn(async () =>
      response({ next_page_results: false, results: [{ id: "PROJECT-ID", name: "Web" }] }),
    );
    const contextStore = createMemoryContextStore();
    const serverA = await startPlaneMcpHttpServer({
      contextStore,
      cwd,
      env: {},
      fetch,
      home: cwd,
      host: "127.0.0.1",
      port: 0,
    });
    const serverB = await startPlaneMcpHttpServer({
      contextStore,
      cwd,
      env: {},
      fetch,
      home: cwd,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const headers: Record<string, string> = {};
      await rpc(serverA.url, "initialize", {
        capabilities: {},
        clientInfo: { name: "non-sticky-test", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      }, headers);

      await rpc(serverB.url, "tools/call", {
        arguments: { project: "Web", workspace: "prod" },
        name: "plane_context_set",
      }, headers);
      const context = (await rpc(serverA.url, "tools/call", {
        arguments: {},
        name: "plane_context_get",
      }, headers)) as { result: { structuredContent: unknown } };
      const projects = (await rpc(serverB.url, "tools/call", {
        arguments: {},
        name: "project_list",
      }, headers)) as { result: { structuredContent: unknown } };

      expect(context.result.structuredContent).toEqual({
        data: { project: "Web", workspace: "prod" },
        ok: true,
      });
      expect(projects.result.structuredContent).toEqual({
        data: [{ id: "PROJECT-ID", name: "Web" }],
        ok: true,
        workspace: "prod",
      });
    } finally {
      await Promise.all([serverA.close(), serverB.close()]);
    }
  });

  test("rejects unknown Streamable HTTP session ids without local transport state", async () => {
    const server = await startPlaneMcpHttpServer({ env: {}, host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(server.url, {
        body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "tools/list" }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": "missing-session",
        },
        method: "POST",
      });

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({
        error: { message: "Invalid MCP session ID." },
        jsonrpc: "2.0",
      });
    } finally {
      await server.close();
    }
  });

  test("does not expose or preserve sessions for rejected initialize requests", async () => {
    const backingStore = createMemoryContextStore();
    const createdSessionIds: string[] = [];
    const deletedSessionIds: string[] = [];
    const contextStore = {
      ...backingStore,
      async createSession(sessionId: string) {
        createdSessionIds.push(sessionId);
        await backingStore.createSession(sessionId);
      },
      async deleteSession(sessionId: string) {
        deletedSessionIds.push(sessionId);
        await backingStore.deleteSession(sessionId);
      },
    };
    const server = await startPlaneMcpHttpServer({
      contextStore,
      env: {},
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const rejected = await fetch(server.url, {
        body: JSON.stringify({
          id: "1",
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "bad-accept-test", version: "0.0.0" },
            protocolVersion: "2025-06-18",
          },
        }),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(rejected.status).toBe(406);
      expect(rejected.headers.get("mcp-session-id")).toBeNull();
      expect(createdSessionIds).toHaveLength(1);
      expect(deletedSessionIds).toEqual(createdSessionIds);
      await expect(contextStore.hasSession(createdSessionIds[0]!)).resolves.toBe(false);
    } finally {
      await server.close();
    }
  });

  test("returns JSON-RPC parse errors for malformed Streamable HTTP JSON", async () => {
    const server = await startPlaneMcpHttpServer({ env: {}, host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(server.url, {
        body: "{",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: -32700 },
        id: null,
        jsonrpc: "2.0",
      });
    } finally {
      await server.close();
    }
  });

  test("rejects DELETE requests for unknown Streamable HTTP session ids", async () => {
    const server = await startPlaneMcpHttpServer({ env: {}, host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(server.url, {
        headers: { "mcp-session-id": "missing-session" },
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({
        error: { message: "Invalid MCP session ID." },
        jsonrpc: "2.0",
      });
    } finally {
      await server.close();
    }
  });

  test("allows DELETE requests for known Streamable HTTP session ids", async () => {
    const server = await startPlaneMcpHttpServer({ env: {}, host: "127.0.0.1", port: 0 });
    try {
      const headers: Record<string, string> = {};
      await rpc(server.url, "initialize", {
        capabilities: {},
        clientInfo: { name: "delete-session-test", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      }, headers);

      const deleted = await fetch(server.url, {
        headers,
        method: "DELETE",
      });
      expect(deleted.status).toBe(200);

      const afterDelete = await fetch(server.url, {
        body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "tools/list" }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...headers,
        },
        method: "POST",
      });
      expect(afterDelete.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  test("returns structured sanitized errors from tool calls", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: dev\nworkspaces:\n  dev:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const client = await connectClient(createPlaneMcpServer({ cwd, env: {}, home: cwd }));

    const result = await client.callTool({
      arguments: { workspace: "prod" },
      name: "project_list",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "WORKSPACE_NOT_FOUND",
        details: { workspace: "prod" },
        message: "Workspace 'prod' is not configured.",
      },
      ok: false,
    });
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/api[_-]?key|secret|token/i);
  });

  test("denies MCP file flags outside the configured workspace root", async () => {
    const cwd = await tempDir();
    const outside = await tempDir();
    const filtersPath = join(outside, "filters.json");
    await writeFile(filtersPath, "{}");
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi.fn();
    const client = await connectClient(createPlaneMcpServer({ cwd, env: {}, fetch, home: cwd }));

    const result = await client.callTool({
      arguments: { filters_file: filtersPath, workspace: "prod" },
      name: "issue_advanced_search",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        details: { flag: "filters-file" },
        message: "MCP file flag --filters-file must resolve inside the configured workspace root.",
      },
      ok: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("denies MCP file flags that escape through workspace symlinks", async () => {
    const cwd = await tempDir();
    const outside = await tempDir();
    const filtersPath = join(outside, "filters.json");
    const linkPath = join(cwd, "filters-link.json");
    await writeFile(filtersPath, "{}");
    await symlink(filtersPath, linkPath);
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi.fn();
    const client = await connectClient(createPlaneMcpServer({ cwd, env: {}, fetch, home: cwd }));

    const result = await client.callTool({
      arguments: { filters_file: "filters-link.json", workspace: "prod" },
      name: "issue_advanced_search",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        details: { flag: "filters-file" },
        message: "MCP file flag --filters-file must resolve inside the configured workspace root.",
      },
      ok: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
