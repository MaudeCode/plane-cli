import { mkdtemp, writeFile } from "node:fs/promises";
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

async function rpc(url: string, method: string, params?: unknown): Promise<unknown> {
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
    },
    method: "POST",
  });

  expect(res.status).toBe(200);
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

    expect(names).toEqual(expect.arrayContaining(["issue_get", "project_list", "comment_create"]));
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
      await rpc(server.url, "initialize", {
        capabilities: {},
        clientInfo: { name: "raw-json-rpc-test", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      });

      const listResponse = (await rpc(server.url, "tools/list")) as {
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

  test("honors repo project hints through MCP execution", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    await writeFile(join(cwd, ".plane-cli-workspace"), "workspace: prod\nproject: Web\n");
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
});
