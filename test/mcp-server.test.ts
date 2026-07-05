import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test, vi } from "vitest";
import { createPlaneMcpServer } from "../src/mcp/server.js";
import { startPlaneMcpHttpServer } from "../src/mcp/http.js";

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

  test("returns structured sanitized errors from tool calls", async () => {
    const client = await connectClient(createPlaneMcpServer({ env: {} }));

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
